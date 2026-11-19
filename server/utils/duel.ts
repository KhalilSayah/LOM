import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DRAFT_ORDER, DRAFT_LENGTH, SLOTS, ACTION_SECONDS, BONUS_SECONDS,
  stepAt, takenChampions, filledSlots, illegalBecause,
  type LockedAction, type Side, type Slot,
} from '~~/shared/draft';
import { CARD_SELECT, toCard } from '~~/shared/cardShape';
import { chemistryFor } from '~~/shared/roster';
import { championRoles, roleForFit } from './championRoles';
import { effRating } from '~~/packages/core/src/index.js';
import { simulate, configureChampionData } from '~~/packages/sim/src/index.js';
import { compositionFor } from '~~/packages/sim/src/champions.js';
import championTable from '~~/data/champions.json';

/**
 * A duel, end to end: snapshot the lineups, run the draft, simulate the match.
 *
 * The server is the only writer. A client sends "I pick this champion into this slot" and
 * everything else — whose turn it is, what is still available, whether the clock ran out —
 * is decided here against the action log, because the action log is the only record both
 * players can be held to.
 */

// The sim holds no asset dependency and takes its champion knowledge by injection
// (docs/04 section 2). Installing it once per process is enough, and without it the
// composition modifier is a flat 1.0 for every draft ever played.
configureChampionData((championTable as any).champions);

export interface DuelCard {
  cardKey: string;
  name: string;
  slot: Slot;
  ovr: number;
  level: number;
  rarity: string;
  season: number | null;
  team: string | null;
  region: string | null;
  subStats: Record<string, number>;
  /** championKey -> mastery, which is what decides who can actually play a pick. */
  pool: Record<string, number>;
  poolNames: Record<string, string>;
  artChampionKey: string | null;
}

export type Lineup = Record<Slot, DuelCard | null>;

/**
 * The five cards a manager brings, copied at accept.
 *
 * A copy rather than a reference on purpose. docs/05 section 1 locks lineups before the
 * draft opens, and a snapshot also means a finished duel still renders months later even if
 * the card has since been levelled, re-rated by a new catalogue, or traded away.
 */
export async function snapshotLineup(db: SupabaseClient, profileId: string): Promise<Lineup> {
  const [{ data: slots }, { data: owned }] = await Promise.all([
    db.from('roster_slots').select('role, collection_card_id').eq('profile_id', profileId),
    db.from('collection_cards')
      .select(`id, level, card_definitions ( ${CARD_SELECT} )`)
      .eq('profile_id', profileId),
  ]);

  const byId = new Map((owned || []).map((row: any) => [row.id, row]));
  const out = {} as Lineup;
  for (const slot of SLOTS) out[slot] = null;

  for (const row of slots || []) {
    const held = byId.get((row as any).collection_card_id);
    if (!held?.card_definitions) continue;
    const card = toCard(held.card_definitions as any);
    const pool: Record<string, number> = {};
    const poolNames: Record<string, string> = {};
    for (const entry of card.championPool || []) {
      pool[entry.key] = entry.mastery;
      poolNames[entry.key] = entry.champion;
    }
    out[(row as any).role as Slot] = {
      cardKey: card.cardKey,
      name: card.playerName,
      slot: (row as any).role as Slot,
      ovr: card.ovr,
      level: held.level ?? 1,
      rarity: card.rarity,
      season: card.season ?? null,
      team: card.team ?? null,
      region: card.region ?? null,
      subStats: card.subStats || {},
      pool,
      poolNames,
      artChampionKey: card.artChampionKey ?? null,
    };
  }
  return out;
}

export const lineupComplete = (lineup: Lineup) => SLOTS.every((s) => lineup[s]);

/** What a card is worth on a champion, in the slot it is being put in. */
export function ratingFor(
  card: DuelCard | null,
  championKey: string,
  slot: Slot,
  roles: Map<string, any>,
): number {
  if (!card) return 30;
  return effRating({
    ovr: card.ovr,
    level: card.level,
    mastery: card.pool[championKey] ?? 0,
    championRole: roleForFit(roles, championKey, slot),
    slot,
  });
}

// --- the auto-draft agent ----------------------------------------------------

export interface Champion { key: string; name: string }

/**
 * docs/05 section 4: competent, not optimal.
 *
 * "It should play like a reasonable friend who is not paying full attention. If it played
 * perfectly, nobody would show up." That is a design constraint, not an excuse — the noise
 * and the single ply of lookahead are deliberate, and deepening either would make a bot that
 * beats people, which is the wrong outcome for a game about collecting cards.
 */
export function autoPick(
  lineup: Lineup,
  opponent: Lineup,
  actions: LockedAction[],
  side: Side,
  pool: Champion[],
  roles: Map<string, any>,
  rand: () => number,
): { championKey: string; championName: string; slot: Slot } {
  const taken = takenChampions(actions);
  const filled = filledSlots(actions, side);
  const openSlots = SLOTS.filter((s) => !filled.has(s));
  const available = pool.filter((c) => !taken.has(c.key));

  // What my comp already looks like, so a pick can be scored on what it adds.
  const mine = picksSoFar(actions, side);
  const baseComp = compOf(mine);

  let best: { championKey: string; championName: string; slot: Slot; score: number } | null = null;

  for (const champ of available) {
    for (const slot of openSlots) {
      const rating = ratingFor(lineup[slot], champ.key, slot, roles);

      const compAfter = compOf([...mine, { slot, champion: champ.name }]);
      const compDelta = (compAfter - baseComp) * 100;

      // Playable in more than one of my empty slots is worth something: it keeps my
      // options open and makes me harder to ban out.
      const flex = openSlots.filter((s) => (lineup[s]?.pool[champ.key] ?? 0) >= 60).length;
      const flexValue = Math.max(0, flex - 1);

      // How much the opponent wants it, measured the same way I do.
      const denial = Math.max(...SLOTS.map((s) => ratingFor(opponent[s], champ.key, s, roles)));
      const denialRisk = Math.max(0, denial - 60) / 10;

      const score = rating + 6 * compDelta + 2 * flexValue - 3 * denialRisk + rand() * 2;
      if (!best || score > best.score) {
        best = { championKey: champ.key, championName: champ.name, slot, score };
      }
    }
  }

  const fallback = available[0]!;
  return best
    ? { championKey: best.championKey, championName: best.championName, slot: best.slot }
    : { championKey: fallback.key, championName: fallback.name, slot: openSlots[0]! };
}

/**
 * docs/05 section 4.2: ban what costs the opponent the most, measured as the gap between
 * that champion and their next-best option.
 *
 * Scoring the gap rather than the champion is what makes bans look like they were aimed at
 * a person. Banning "the strongest champion" is what a bot does; banning the one champion a
 * particular card is 40 points better on is what an opponent does.
 */
export function autoBan(
  opponent: Lineup,
  actions: LockedAction[],
  oppSide: Side,
  pool: Champion[],
  roles: Map<string, any>,
  rand: () => number,
): { championKey: string; championName: string } {
  const taken = takenChampions(actions);
  const oppFilled = filledSlots(actions, oppSide);
  const openSlots = SLOTS.filter((s) => !oppFilled.has(s));
  const available = pool.filter((c) => !taken.has(c.key));

  let best: { championKey: string; championName: string; score: number } | null = null;

  for (const champ of available) {
    let worst = 0;
    for (const slot of openSlots) {
      const card = opponent[slot];
      if (!card) continue;
      const withIt = ratingFor(card, champ.key, slot, roles);
      // Their next best, if this were gone.
      let nextBest = 30;
      for (const other of available) {
        if (other.key === champ.key) continue;
        const r = ratingFor(card, other.key, slot, roles);
        if (r > nextBest) nextBest = r;
      }
      worst = Math.max(worst, withIt - nextBest);
    }
    const score = worst + rand();
    if (!best || score > best.score) {
      best = { championKey: champ.key, championName: champ.name, score };
    }
  }

  const fallback = available[0]!;
  return best ?? { championKey: fallback.key, championName: fallback.name };
}

const picksSoFar = (actions: LockedAction[], side: Side) =>
  actions.filter((a) => a.side === side && a.kind === 'PICK' && a.slot)
    .map((a) => ({ slot: a.slot as Slot, champion: a.championName }));

/**
 * The composition modifier of a partial draft.
 *
 * compositionFor() wants five players and judges a comp on what it is missing, so scoring a
 * half-finished draft with it would punish every early pick for the picks that have not
 * happened. Empty slots are filled with the slot's own name, which the champion table does
 * not know, and an unknown champion makes the whole thing return a flat 1.0 — so a partial
 * comp scores neutral and only a complete one moves, which is the honest reading.
 */
function compOf(picks: Array<{ slot: Slot; champion: string }>): number {
  if (picks.length < SLOTS.length) {
    const filled = new Map(picks.map((p) => [p.slot, p.champion]));
    const players = SLOTS.map((slot) => ({ slot, champion: filled.get(slot) ?? `__empty_${slot}` }));
    return compositionFor(players as any, { min: 0.92, max: 1.08 }).modifier;
  }
  return compositionFor(picks.map((p) => ({ slot: p.slot, champion: p.champion })) as any,
    { min: 0.92, max: 1.08 }).modifier;
}

// --- timers ------------------------------------------------------------------

export const deadlineFor = (seconds = ACTION_SECONDS) =>
  new Date(Date.now() + seconds * 1000).toISOString();

/**
 * docs/05 section 3.3. The clock is authoritative here and nowhere else; a client renders a
 * countdown from `deadlineAt` and never decides an expiry.
 *
 * Bonus time is spent before an action is taken away: a side that is thinking has 30 seconds
 * and then eats into its 60-second pool, and only when both are gone does the agent act. The
 * draft never waits indefinitely and never cancels (docs/05 section 1) — that rule is what
 * stops one person's absence ending someone else's evening.
 */
export function expiredBy(deadlineAt: string | null): number {
  if (!deadlineAt) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(deadlineAt).getTime()) / 1000));
}
