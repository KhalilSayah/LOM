import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { phaseOf, timingOfRow, matchEnd } from '~~/shared/duelRoom';
import { expireStaleChallenges, challengeCutoff } from '~~/server/utils/duel';
import { settleIfWatched } from '~~/server/utils/duelRun';

/**
 * Every duel this manager is part of, split by what it wants from them.
 *
 * `incoming` is the only one that needs a decision, so it is what the badge counts and
 * what the screen puts first.
 *
 * Each bucket is its own query. They used to share one `limit(40)` over every duel ever
 * played, so somebody with forty finished games had their pending challenges cut off the
 * end of the list while the nav badge — counting them separately — still said they were
 * there. The record is its own query too, over far more rows than the list shows, because a
 * W-L worked out from whatever happened to fit on one screen changes every time the screen
 * does.
 *
 * Live is decided by phase, not status. A duel stays WATCHING until somebody catches it up,
 * and one that both players walked away from during the match was never caught up — so it
 * sat on this screen offering "Rejoin" for hours and was missing from history. Here a room
 * whose match is over goes to history, and is settled on the way past.
 */

const BASE = 'id, status, source, bot_side, difficulty, challenger_id, opponent_id, blue_id, red_id, turn, created_at, completed_at';
// Everything the history row shows, without the event log it does not.
const LIGHT = `${BASE}, box:result->boxScore, game_length:result->gameLength, winner:result->>winner, last_t:result->events->-1->t`;

type Category = 'battles' | 'friendlies' | 'practice' | 'league';
const CATEGORY: Record<string, Category> = { QUEUE: 'battles', CHALLENGE: 'friendlies', BOT: 'practice', LEAGUE: 'league' };

export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const mine = `challenger_id.eq.${profileId},opponent_id.eq.${profileId}`;
  const cutoff = challengeCutoff();

  // Write off challenges nobody answered in a day. Every read below filters on the cutoff
  // as well, so this failing changes nothing anyone sees.
  await expireStaleChallenges(db, profileId).catch(() => {});

  const history = async () => {
    const light = await db.from('duels').select(LIGHT)
      .eq('status', 'COMPLETE').or(mine)
      .order('created_at', { ascending: false }).limit(30);
    if (!light.error) return light.data || [];
    // A PostgREST without negative JSON indexes: take the whole result instead.
    const full = await db.from('duels').select(`${BASE}, result`)
      .eq('status', 'COMPLETE').or(mine)
      .order('created_at', { ascending: false }).limit(30);
    return full.data || [];
  };

  const [incomingQ, outgoingQ, liveQ, finishedRows, recordQ] = await Promise.all([
    db.from('duels').select(BASE)
      .eq('status', 'PENDING').eq('opponent_id', profileId).gte('created_at', cutoff)
      .order('created_at', { ascending: false }).limit(50),
    db.from('duels').select(BASE)
      .eq('status', 'PENDING').eq('challenger_id', profileId).gte('created_at', cutoff)
      .order('created_at', { ascending: false }).limit(50),
    db.from('duels').select(`${BASE}, starts_at, watch_start_at, watch_speed, result`)
      .in('status', ['DRAFTING', 'WATCHING']).or(mine)
      .order('created_at', { ascending: false }).limit(20),
    history(),
    db.from('duels')
      .select('id, source, bot_side, challenger_id, opponent_id, blue_id, red_id, winner:result->>winner, created_at')
      .eq('status', 'COMPLETE').or(mine)
      .order('created_at', { ascending: false }).limit(1000),
  ]);

  // Split the "live" rows by what they really are now.
  const now = Date.now();
  const live: any[] = [];
  const justFinished: any[] = [];
  for (const d of liveQ.data || []) {
    const phase = phaseOf(timingOfRow(d as any), now);
    if (phase === 'RESULT') {
      await settleIfWatched(db, d);
      justFinished.push(d);
    } else {
      live.push({ ...d, phase });
    }
  }

  const finished = [...justFinished, ...finishedRows]
    .sort((a: any, b: any) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 30);

  const sideOf = (d: any) => (d.blue_id === profileId ? 'BLUE' : d.red_id === profileId ? 'RED' : null);
  const otherOf = (d: any) => (d.challenger_id === profileId ? d.opponent_id : d.challenger_id) as string | null;
  const winnerOf = (d: any) => d.winner ?? d.result?.winner ?? null;
  const wonOf = (d: any) => {
    const w = winnerOf(d);
    const s = sideOf(d);
    return w && s ? w === s : null;
  };

  // --- the record, from enough rows to mean something --------------------------------
  const recordRows = [
    ...justFinished.filter((d) => !(recordQ.data || []).some((r: any) => r.id === d.id)),
    ...(recordQ.data || []),
  ].sort((a: any, b: any) => (a.created_at < b.created_at ? 1 : -1));

  const tally = () => ({ wins: 0, losses: 0, streak: 0, streakWon: false, played: 0 });
  const record: Record<Category, ReturnType<typeof tally>> = {
    battles: tally(), friendlies: tally(), practice: tally(), league: tally(),
  };
  const streakOpen: Record<Category, boolean> = { battles: true, friendlies: true, practice: true, league: true };
  /** Head-to-head against each human opponent, over every game played with them. */
  const h2h = new Map<string, { wins: number; losses: number; last: string }>();

  for (const d of recordRows) {
    const won = wonOf(d);
    if (won === null) continue;
    const cat = CATEGORY[d.source ?? 'CHALLENGE'] ?? 'friendlies';
    const r = record[cat];
    r.played++;
    if (won) r.wins++; else r.losses++;
    if (streakOpen[cat]) {
      if (r.streak === 0) { r.streak = 1; r.streakWon = won; }
      else if (r.streakWon === won) r.streak++;
      else streakOpen[cat] = false;
    }
    const other = d.bot_side ? null : otherOf(d);
    if (other) {
      const h = h2h.get(other) ?? { wins: 0, losses: 0, last: d.created_at };
      if (won) h.wins++; else h.losses++;
      h2h.set(other, h);
    }
  }

  // --- names --------------------------------------------------------------------------
  const rows = [...(incomingQ.data || []), ...(outgoingQ.data || []), ...live, ...finished];
  /**
   * The opponents worth looking up — which excludes the agent, because it is not one.
   *
   * A bot duel has `opponent_id is null`, so without the filter this set contains a null,
   * `.in('id', [null])` becomes `id=in.(null)` on the wire, and Postgres rejects it as an
   * invalid uuid. The whole screen 500s, and it does so only for people who have played the
   * agent — which, with most rosters still unfilled, is almost everyone.
   */
  const recentOpponentIds = [...h2h.entries()]
    .sort((a, b) => (a[1].last < b[1].last ? 1 : -1))
    .slice(0, 6)
    .map(([id]) => id);
  const others = [...new Set([...rows.map(otherOf), ...recentOpponentIds])]
    .filter((id): id is string => Boolean(id));
  const { data: profiles } = others.length
    ? await db.from('profiles').select('id, handle, display_name').in('id', others)
    : { data: [] as any[] };
  const byId = new Map((profiles || []).map((p: any) => [p.id, p]));
  const nameOf = (id: string | null) => {
    const p = id ? byId.get(id) : null;
    return p?.display_name || p?.handle || 'Unknown manager';
  };

  const killsFor = (box: any[], side: string) => {
    let mineK = 0;
    let theirs = 0;
    for (const r of box) {
      if (r.team === side) mineK += r.kills ?? 0;
      else theirs += r.kills ?? 0;
    }
    return { mine: mineK, theirs };
  };

  const shape = (d: any) => {
    const otherId = d.bot_side ? null : otherOf(d);
    const mySide = sideOf(d);
    const box = d.box ?? d.result?.boxScore ?? null;
    const lastT = d.last_t ?? (d.result ? matchEnd(d.result) : null);
    const length = d.game_length ?? d.result?.gameLength ?? null;
    const h = otherId ? h2h.get(otherId) : null;
    return {
      id: d.id,
      status: d.status,
      phase: d.phase ?? null,
      source: d.source ?? 'CHALLENGE',
      isBot: Boolean(d.bot_side),
      difficulty: d.difficulty ?? null,
      opponent: d.bot_side ? 'The agent' : nameOf(otherId),
      opponentHandle: otherId ? byId.get(otherId)?.handle ?? null : null,
      opponentId: otherId,
      iChallenged: d.challenger_id === profileId,
      side: mySide,
      turn: d.turn,
      createdAt: d.created_at,
      completedAt: d.completed_at,
      // Only meaningful once the match has been played; null while a draft is still running.
      won: wonOf(d),
      score: Array.isArray(box) && mySide ? killsFor(box, mySide) : null,
      // The nexus can fall up to a minute of match time after `gameLength`; quote when it did.
      gameLength: length !== null || lastT !== null
        ? Math.max(Number(length ?? 0), Number(lastT ?? 0))
        : null,
      h2h: h ? { wins: h.wins, losses: h.losses } : null,
    };
  };

  return {
    incoming: (incomingQ.data || []).map(shape),
    outgoing: (outgoingQ.data || []).map(shape),
    /**
     * One bucket for both live phases. A draft you are in and a match still playing are the
     * same thing from this screen's point of view — a room you should be offered back into.
     */
    live: live.map(shape),
    finished: finished.map(shape),
    /**
     * Battles (the queue) first and on their own; friendlies, practice and league games kept
     * apart. There is no ladder and nothing here is a rating — friendlies and practice never
     * count anywhere — but a record that mixes "beat the agent on Easy" into "won against
     * people" is a record that means nothing.
     */
    record,
    opponents: recentOpponentIds.map((id) => ({
      id,
      name: nameOf(id),
      handle: byId.get(id)?.handle ?? null,
      wins: h2h.get(id)!.wins,
      losses: h2h.get(id)!.losses,
      lastPlayedAt: h2h.get(id)!.last,
    })),
  };
});
