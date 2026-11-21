/**
 * Daily and weekly quests.
 *
 * Small reasons to come back: three dailies that turn over at the pack-day roll (17:00 in
 * the league timezone, the same moment as the daily pack) and three weeklies that turn over
 * on Monday's roll. Which three are live is a pure function of the period, so every manager
 * sees the same quests on the same day and nothing needs scheduling.
 *
 * Progress is never stored. It is read from what already happened — the duels a manager
 * was paid for (match_rewards, one row per manager per finished duel, stamped with its pack
 * day), the lineup each side brought, the draft's action log, the box score, and the daily
 * claims — so a quest cannot be advanced by anything other than playing. The only durable
 * thing is the payout, in quest_claims, whose unique key makes a claim pay once.
 *
 * Only the current period can be claimed. A quest finished and not claimed before the roll
 * is gone with its period: the point is to come back, and it costs nothing that was owned.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { addDays, weekStartOf, zonedToUtc, type PackWindow } from './packDay';

export type QuestScope = 'DAILY' | 'WEEKLY';

/** What a period's play adds up to. Every quest reads one of these. */
export interface QuestFacts {
  matches: number;
  wins: number;
  masteryWins: number;
  bannedTop: number;
  oldCardMatches: number;
  sGrades: number;
  bigKillMatches: number;
  dailyOpens: number;
}

export interface QuestDef {
  key: string;
  scope: QuestScope;
  title: string;
  detail: string;
  target: number;
  credits: number;
  metric: keyof QuestFacts;
}

/** Mastery at or above this counts as "a champion they really play". */
export const MASTERY_BAR = 85;
/** Cards from a season before this one count as old. */
export const OLD_SEASON = 2018;
export const BIG_KILLS = 20;
export const QUESTS_PER_PERIOD = 3;

export const DAILY_QUESTS: QuestDef[] = [
  { key: 'D_WIN', scope: 'DAILY', title: 'Win a battle', detail: 'Any match counts, the agent included.', target: 1, credits: 60, metric: 'wins' },
  { key: 'D_PLAY_2', scope: 'DAILY', title: 'Play 2 matches', detail: 'Win or lose.', target: 2, credits: 40, metric: 'matches' },
  { key: 'D_OPEN', scope: 'DAILY', title: 'Open your daily pack', detail: 'A banked pack opened today counts.', target: 1, credits: 25, metric: 'dailyOpens' },
  { key: 'D_MASTERY', scope: 'DAILY', title: `Win with a champion at ${MASTERY_BAR}+ mastery`, detail: 'Give one of your five a champion they have mastered, and win.', target: 1, credits: 70, metric: 'masteryWins' },
  { key: 'D_BAN_TOP', scope: 'DAILY', title: "Ban your opponent's most-mastered champion", detail: 'Read their five before the draft, and take it away.', target: 1, credits: 60, metric: 'bannedTop' },
  { key: 'D_OLD', scope: 'DAILY', title: `Field a card from before ${OLD_SEASON}`, detail: 'Any season up to 2017, in any slot.', target: 1, credits: 40, metric: 'oldCardMatches' },
  { key: 'D_S_GRADE', scope: 'DAILY', title: 'Have a starter graded S', detail: 'S or S+ in the box score.', target: 1, credits: 60, metric: 'sGrades' },
  { key: 'D_KILLS', scope: 'DAILY', title: `Score ${BIG_KILLS} kills in a match`, detail: 'Your side, added up.', target: 1, credits: 50, metric: 'bigKillMatches' },
];

export const WEEKLY_QUESTS: QuestDef[] = [
  { key: 'W_WIN_5', scope: 'WEEKLY', title: 'Win 5 battles', detail: 'Across the week.', target: 5, credits: 250, metric: 'wins' },
  { key: 'W_PLAY_10', scope: 'WEEKLY', title: 'Play 10 matches', detail: 'Win or lose.', target: 10, credits: 200, metric: 'matches' },
  { key: 'W_OPEN_5', scope: 'WEEKLY', title: 'Open your daily pack on 5 days', detail: 'Five different days this week.', target: 5, credits: 150, metric: 'dailyOpens' },
  { key: 'W_MASTERY_3', scope: 'WEEKLY', title: `Win 3 battles with a champion at ${MASTERY_BAR}+ mastery`, detail: 'Comfort picks, three times.', target: 3, credits: 220, metric: 'masteryWins' },
  { key: 'W_OLD_3', scope: 'WEEKLY', title: `Field a card from before ${OLD_SEASON} in 3 matches`, detail: 'The old guard, three times.', target: 3, credits: 150, metric: 'oldCardMatches' },
  { key: 'W_S_GRADES_5', scope: 'WEEKLY', title: 'Earn 5 S grades', detail: 'Added up across your starters and matches.', target: 5, credits: 200, metric: 'sGrades' },
  { key: 'W_BAN_TOP_3', scope: 'WEEKLY', title: "Ban the opponent's most-mastered champion 3 times", detail: 'Three different matches.', target: 3, credits: 180, metric: 'bannedTop' },
];

const ALL = new Map([...DAILY_QUESTS, ...WEEKLY_QUESTS].map((q) => [q.key, q]));
export const questByKey = (key: string) => ALL.get(key) ?? null;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seeded(seed: number) {
  let a = seed || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The quests live in a period: the same three for everybody, decided by the period alone. */
export function questsFor(scope: QuestScope, periodKey: string): QuestDef[] {
  const pool = (scope === 'DAILY' ? DAILY_QUESTS : WEEKLY_QUESTS).slice();
  const rng = seeded(hash(`${scope}|${periodKey}`));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, QUESTS_PER_PERIOD);
}

export interface Period {
  scope: QuestScope;
  key: string;
  firstDay: string;
  lastDay: string;
  endsAt: string;
}

export function periodsFor(window: PackWindow): { daily: Period; weekly: Period } {
  const monday = weekStartOf(window.packDay);
  const nextMonday = addDays(monday, 7);
  const [y, m, d] = nextMonday.split('-').map(Number);
  return {
    daily: {
      scope: 'DAILY',
      key: window.packDay,
      firstDay: window.packDay,
      lastDay: window.packDay,
      endsAt: window.nextOpensAt.toISOString(),
    },
    weekly: {
      scope: 'WEEKLY',
      key: `W${monday}`,
      firstDay: monday,
      lastDay: addDays(monday, 6),
      endsAt: zonedToUtc(y!, m!, d!, window.hour, window.timeZone).toISOString(),
    },
  };
}

const S_GRADES = new Set(['S', 'S+']);

/** Everything a manager did between two pack days, inclusive. */
export async function factsFor(
  db: SupabaseClient,
  profileId: string,
  firstDay: string,
  lastDay: string,
): Promise<QuestFacts> {
  const facts: QuestFacts = {
    matches: 0, wins: 0, masteryWins: 0, bannedTop: 0,
    oldCardMatches: 0, sGrades: 0, bigKillMatches: 0, dailyOpens: 0,
  };

  const [{ data: paid }, { data: opened }] = await Promise.all([
    db.from('match_rewards')
      .select('duel_id, won')
      .eq('profile_id', profileId)
      .gte('pack_day', firstDay)
      .lte('pack_day', lastDay),
    db.from('pack_claims')
      .select('opened_day')
      .eq('profile_id', profileId)
      .not('settled_at', 'is', null)
      .gte('opened_day', firstDay)
      .lte('opened_day', lastDay),
  ]);

  facts.dailyOpens = new Set((opened || []).map((r: any) => String(r.opened_day))).size;

  const duelIds = [...new Set((paid || []).map((r: any) => r.duel_id as string))];
  if (!duelIds.length) return facts;

  const [{ data: duels }, { data: actions }] = await Promise.all([
    db.from('duels')
      .select('id, blue_id, red_id, blue_lineup, red_lineup, result')
      .in('id', duelIds),
    db.from('duel_actions')
      .select('duel_id, side, kind, champion_key, slot')
      .in('duel_id', duelIds),
  ]);

  const byDuel = new Map<string, any[]>();
  for (const a of (actions || []) as any[]) {
    const list = byDuel.get(a.duel_id) ?? [];
    list.push(a);
    byDuel.set(a.duel_id, list);
  }

  for (const duel of (duels || []) as any[]) {
    if (!duel.result) continue;
    const side = duel.blue_id === profileId ? 'BLUE' : duel.red_id === profileId ? 'RED' : null;
    if (!side) continue;
    const mine = (side === 'BLUE' ? duel.blue_lineup : duel.red_lineup) || {};
    const theirs = (side === 'BLUE' ? duel.red_lineup : duel.blue_lineup) || {};
    const won = duel.result?.winner === side;
    const acts = byDuel.get(duel.id) ?? [];

    facts.matches += 1;
    if (won) facts.wins += 1;

    // A pick on a champion the card in that slot has mastered.
    if (won && acts.some((a) => a.side === side && a.kind === 'PICK' && a.slot
      && Number(mine[a.slot]?.pool?.[a.champion_key] ?? 0) >= MASTERY_BAR)) {
      facts.masteryWins += 1;
    }

    // The opponent's single most-mastered champion (ties all count), banned by this side.
    let top = 0;
    const topKeys = new Set<string>();
    for (const card of Object.values(theirs) as any[]) {
      for (const [key, mastery] of Object.entries(card?.pool || {})) {
        const m = Number(mastery) || 0;
        if (m > top) { top = m; topKeys.clear(); topKeys.add(key); } else if (m === top && m > 0) topKeys.add(key);
      }
    }
    if (top > 0 && acts.some((a) => a.side === side && a.kind === 'BAN' && topKeys.has(a.champion_key))) {
      facts.bannedTop += 1;
    }

    if ((Object.values(mine) as any[]).some((c) => c && Number(c.season) > 0 && Number(c.season) < OLD_SEASON)) {
      facts.oldCardMatches += 1;
    }

    let kills = 0;
    for (const row of duel.result?.boxScore || []) {
      if (row.team !== side) continue;
      kills += Number(row.kills) || 0;
      if (S_GRADES.has(row.grade)) facts.sGrades += 1;
    }
    if (kills >= BIG_KILLS) facts.bigKillMatches += 1;
  }

  return facts;
}

export interface QuestView {
  key: string;
  scope: QuestScope;
  title: string;
  detail: string;
  target: number;
  progress: number;
  credits: number;
  done: boolean;
  claimed: boolean;
}

export interface QuestBoard {
  daily: { periodKey: string; endsAt: string; quests: QuestView[] };
  weekly: { periodKey: string; endsAt: string; quests: QuestView[] };
  /** Done and not yet claimed, both scopes. */
  claimable: number;
  dailyDone: number;
}

export async function questBoard(db: SupabaseClient, profileId: string, window: PackWindow): Promise<QuestBoard> {
  const { daily, weekly } = periodsFor(window);

  const [dayFacts, weekFacts, { data: claims }] = await Promise.all([
    factsFor(db, profileId, daily.firstDay, daily.lastDay),
    factsFor(db, profileId, weekly.firstDay, weekly.lastDay),
    db.from('quest_claims')
      .select('quest_key, period_key')
      .eq('profile_id', profileId)
      .in('period_key', [daily.key, weekly.key]),
  ]);

  const claimed = new Set((claims || []).map((c: any) => `${c.quest_key}|${c.period_key}`));

  const view = (period: Period, facts: QuestFacts): QuestView[] =>
    questsFor(period.scope, period.key).map((q) => {
      const value = facts[q.metric] ?? 0;
      return {
        key: q.key,
        scope: q.scope,
        title: q.title,
        detail: q.detail,
        target: q.target,
        progress: Math.min(value, q.target),
        credits: q.credits,
        done: value >= q.target,
        claimed: claimed.has(`${q.key}|${period.key}`),
      };
    });

  const dq = view(daily, dayFacts);
  const wq = view(weekly, weekFacts);
  const all = [...dq, ...wq];

  return {
    daily: { periodKey: daily.key, endsAt: daily.endsAt, quests: dq },
    weekly: { periodKey: weekly.key, endsAt: weekly.endsAt, quests: wq },
    claimable: all.filter((q) => q.done && !q.claimed).length,
    dailyDone: dq.filter((q) => q.done).length,
  };
}

/** A summary that never fails, for screens where quests are a side panel. */
export async function questSummary(db: SupabaseClient, profileId: string, window: PackWindow) {
  try {
    const board = await questBoard(db, profileId, window);
    return { dailyDone: board.dailyDone, dailyTotal: board.daily.quests.length, claimable: board.claimable };
  } catch (e: any) {
    console.warn(`[quests] summary failed: ${e?.message}`);
    return { dailyDone: 0, dailyTotal: 0, claimable: 0 };
  }
}
