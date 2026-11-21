import type { SupabaseClient } from '@supabase/supabase-js';
import { ACTION_SECONDS, BONUS_SECONDS } from '~~/shared/draft';
import {
  LOBBY_SECONDS, WATCH_SPEED, phaseOf, timingOfRow, type Difficulty,
} from '~~/shared/duelRoom';
import { snapshotLineup, lineupComplete, newDuelSeed, type Lineup } from './duel';
import { botLineup } from './duelBot';

/**
 * Getting into a room: the queue, and the bot that stands in for an empty one.
 *
 * Everything a client needs before it can be in a duel lives here, and all of it exists to
 * answer one question the old challenge flow never had to: who am I playing? The answer is
 * either "whoever else pressed the button" (the queue, paired by duel_matchmake) or "nobody,
 * so the agent" (the bot). Both end in exactly the same DRAFTING row, which is why the draft
 * screen does not know or care which happened.
 */

export interface Entry {
  /** The frozen five, ready to be handed to pairing or to a bot duel. */
  lineup: Lineup;
  catalogueVersionId: string;
}

/**
 * The lineup and catalogue a room will be built from, or a 4xx explaining why not.
 *
 * Read once, at the top of every entry point, because a lineup that is snapshotted at the
 * moment you press the button and a lineup that is read at the moment somebody happens to
 * pair with you are different lineups — and the second one can change while you wait.
 */
export async function entryFor(db: SupabaseClient, profileId: string): Promise<Entry> {
  const [lineup, { data: active }] = await Promise.all([
    snapshotLineup(db, profileId),
    db.from('catalogue_versions').select('id').eq('is_active', true).maybeSingle(),
  ]);

  if (!lineupComplete(lineup)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Fill all five roster slots before you can battle.',
    });
  }
  if (!active) throw createError({ statusCode: 503, statusMessage: 'No active catalogue.' });

  return { lineup, catalogueVersionId: active.id };
}

/**
 * The room this manager is still needed in, if any.
 *
 * Checked before pairing and before making a bot duel, and it is what the Battle screen
 * navigates into on sight. A player with a live draft who presses Battle has not asked for a
 * second one — they have lost the first, probably by closing a tab, and what they want is to
 * be put back. Returning the existing room is also what stops one person occupying two slots
 * in a queue of two.
 *
 * "Still needed in" is not the same as "not finished", and conflating them is what trapped
 * people on the result screen. A duel stays WATCHING for twenty seconds after the match ends
 * (RESULT_GRACE_SECONDS) so that somebody who looked away still arrives at a live room
 * rather than a history entry. During those twenty seconds the status alone said the room
 * was live, so pressing Battle again from the result screen sent you back to the result
 * screen — again, and again, for as long as the grace lasted. Games appearing to relaunch on
 * their own, with no way to stop them.
 *
 * So the phase decides, not the status, and it decides with the same function the two
 * clients draw their screens from. A match that has finished playing is somewhere you may
 * leave whenever you like.
 */
export async function liveDuelFor(db: SupabaseClient, profileId: string): Promise<string | null> {
  const rooms = await liveDuelsFor(db, profileId);
  return rooms[0]?.id ?? null;
}

/**
 * Every room this manager is still needed in, oldest first.
 *
 * Normally zero or one. More than one is a race — a challenge accepted at the instant the
 * queue paired, a double-pressed practice button — and the oldest is the one that stands,
 * because it is the one the other person has had longest to arrive in.
 *
 * The match's end is matchEnd(result), not `result.gameLength`: the last events land up to a
 * minute of match time after it, and a room that stopped counting as live before its nexus
 * fell let somebody start a second game while their first was still on screen.
 */
export async function liveDuelsFor(
  db: SupabaseClient,
  profileId: string,
): Promise<Array<{ id: string; created_at: string; source: string | null; bot_side: string | null }>> {
  const { data } = await db
    .from('duels')
    .select('id, status, source, bot_side, starts_at, watch_start_at, watch_speed, result, created_at')
    .in('status', ['DRAFTING', 'WATCHING'])
    .or(`challenger_id.eq.${profileId},opponent_id.eq.${profileId}`)
    .order('created_at', { ascending: true })
    .limit(6);

  const now = Date.now();
  return (data || []).filter((duel: any) => {
    const phase = phaseOf(timingOfRow(duel), now);
    return phase === 'LOBBY' || phase === 'DRAFT' || phase === 'WATCH';
  }) as any;
}

/** Refuse, with a sentence a person can act on, if either manager is already in a room. */
export async function assertNotInRoom(
  db: SupabaseClient,
  profileId: string,
  otherId: string | null,
): Promise<void> {
  const [mine, theirs] = await Promise.all([
    liveDuelFor(db, profileId),
    otherId ? liveDuelFor(db, otherId) : Promise.resolve(null),
  ]);
  if (mine) {
    throw createError({
      statusCode: 409,
      statusMessage: 'You are already in a match. Finish it before starting another.',
      data: { duelId: mine },
    });
  }
  if (theirs) {
    throw createError({
      statusCode: 409,
      statusMessage: 'They are in a match right now. Try again when it is over.',
    });
  }
}

/**
 * Drop this manager's queue row if what it points at is over.
 *
 * A row's `duel_id` is how the side that did not do the pairing finds out it was paired, so
 * it has to outlive the pairing — sweepQueue keeps matched rows for two minutes for exactly
 * that reason. The cost is that for those two minutes the row goes on saying "your game is
 * over there" after the game has finished, and both the status endpoint and duel_matchmake
 * believed it.
 *
 * That is what made a duel relaunch. Finish a game, press Battle again, and the stale row
 * sent you back into the room you had just left; from the result screen, Battle again sent
 * you back again. Nothing was being created — the same finished duel was being re-entered,
 * which from the outside looks exactly like games starting on their own and not stopping.
 *
 * So the row is only trusted while the duel it names is still live. Once it is not, the row
 * has done its job and is in the way.
 */
export async function clearSettledEntry(db: SupabaseClient, profileId: string): Promise<void> {
  const { data: mine } = await db
    .from('duel_queue').select('duel_id').eq('profile_id', profileId).maybeSingle();

  if (!mine?.duel_id) return;

  const { data: duel } = await db
    .from('duels').select('status').eq('id', mine.duel_id).maybeSingle();

  const stillLive = duel && (duel.status === 'DRAFTING' || duel.status === 'WATCHING');
  if (!stillLive) await db.from('duel_queue').delete().eq('profile_id', profileId);
}

/**
 * Drop rows nobody is behind any more.
 *
 * A queue row is a claim on being here *now*. It is written when somebody presses Battle and
 * there is no event for "they closed the app", so the only thing that can distinguish a
 * searcher from a ghost is how old the row is. Pairing already refuses stale rows; this
 * removes them, so the count of people waiting is a count of people.
 *
 * Matched rows are swept too, a couple of minutes after the fact. They are kept that long on
 * purpose: the row's duel_id is how the player who did not do the pairing finds out they
 * were paired, and deleting it the instant the duel exists would take that away from a
 * client that was mid-reconnect.
 */
export async function sweepQueue(db: SupabaseClient) {
  const stale = new Date(Date.now() - QUEUE_STALE_SECONDS * 1000).toISOString();
  const settled = new Date(Date.now() - 120 * 1000).toISOString();

  /**
   * Staleness is `last_seen_at`, not `joined_at` (migration 0015).
   *
   * The heartbeat used to refresh nothing the sweep read: duel_matchmake leaves joined_at
   * alone on purpose, so queue order is first-come — and the sweep measured age from that
   * same column. Ninety seconds into any search the searcher was deleted as a ghost while
   * still sitting there, and lost their place. joined_at keeps the order; last_seen_at says
   * whether anybody is still behind the row.
   */
  await Promise.all([
    db.from('duel_queue').delete().is('duel_id', null).lt('last_seen_at', stale),
    db.from('duel_queue').delete().not('matched_at', 'is', null).lt('matched_at', settled),
  ]);
}

/** How long a searching row survives without a heartbeat. The client beats every 15 s. */
export const QUEUE_STALE_SECONDS = 90;

/** How many other managers are searching right now. */
export async function waitingCount(db: SupabaseClient, exclude: string): Promise<number> {
  const since = new Date(Date.now() - QUEUE_STALE_SECONDS * 1000).toISOString();
  const { count } = await db
    .from('duel_queue')
    .select('profile_id', { count: 'exact', head: true })
    .is('duel_id', null)
    .neq('profile_id', exclude)
    .gte('last_seen_at', since);
  return count ?? 0;
}

/**
 * Put the manager with whoever else is searching, or report that nobody is.
 *
 * The pairing itself is one `select ... for update skip locked` inside duel_matchmake, which
 * is the only reason two people pressing Battle in the same instant cannot produce two duels
 * for one match. See migration 0007 section 3 — this function is a thin wrapper and the
 * interesting part is deliberately not here.
 */
export async function matchmake(
  db: SupabaseClient,
  profileId: string,
  entry: Entry,
): Promise<string | null> {
  const { data, error } = await db.rpc('duel_matchmake', {
    p_profile: profileId,
    p_lineup: entry.lineup,
    p_catalogue: entry.catalogueVersionId,
    p_lobby_secs: LOBBY_SECONDS,
    p_action_secs: ACTION_SECONDS,
    p_bonus_secs: BONUS_SECONDS,
  });

  if (error) {
    // 42883 is "function does not exist": migration 0007 has not been run. Worth saying
    // plainly, because the symptom otherwise is a Battle button that does nothing.
    if (error.code === '42883') {
      throw createError({
        statusCode: 503,
        statusMessage: 'Matchmaking is not installed yet. Run migration 0007.',
      });
    }
    throw createError({ statusCode: 500, statusMessage: error.message });
  }

  const duelId = (data as string | null) ?? null;
  if (duelId) return duelId;

  /**
   * Nothing paired, but somebody may have paired *us* between the function returning and
   * this line. The window is tiny and the cost of losing it is that a player sits in a
   * search that already has a game waiting at the other end, so it is worth one read.
   */
  const { data: mine } = await db
    .from('duel_queue').select('duel_id').eq('profile_id', profileId).maybeSingle();
  return mine?.duel_id ?? null;
}

/**
 * A duel against the agent, built to look exactly like a duel against a person.
 *
 * Same table, same statuses, same clock, same draft order. The only differences are
 * `opponent_id is null`, `bot_side`, and `source = 'BOT'` — which is what lets the draft
 * screen, the shared watch and the result be one implementation rather than two.
 */
export async function createBotDuel(
  db: SupabaseClient,
  profileId: string,
  entry: Entry,
  /** Practice difficulty. Null for the agent the queue offers, which always plays NORMAL. */
  difficulty: Difficulty | null = null,
): Promise<string> {
  const seed = newDuelSeed();
  const theirs = await botLineup(db, entry.catalogueVersionId, entry.lineup, seed, difficulty ?? undefined);

  // Drawn, not awarded, exactly as a queue match draws them. The agent gets no edge from
  // last pick and the player gets none from first.
  const playerIsBlue = Math.random() < 0.5;
  const startsAt = new Date(Date.now() + LOBBY_SECONDS * 1000);

  const row: Record<string, any> = {
    challenger_id: profileId,
    opponent_id: null,
    status: 'DRAFTING',
    source: 'BOT',
    bot_side: playerIsBlue ? 'RED' : 'BLUE',
    blue_id: playerIsBlue ? profileId : null,
    red_id: playerIsBlue ? null : profileId,
    blue_lineup: playerIsBlue ? entry.lineup : theirs,
    red_lineup: playerIsBlue ? theirs : entry.lineup,
    catalogue_version_id: entry.catalogueVersionId,
    seed,
    turn: 0,
    bonus: { BLUE: BONUS_SECONDS, RED: BONUS_SECONDS },
    starts_at: startsAt.toISOString(),
    deadline_at: new Date(startsAt.getTime() + ACTION_SECONDS * 1000).toISOString(),
    watch_speed: WATCH_SPEED,
    accepted_at: new Date().toISOString(),
  };
  // Only written when chosen, so a database without migration 0015 still makes bot duels.
  if (difficulty) row.difficulty = difficulty;

  const { data, error } = await db.from('duels').insert(row).select('id').single();

  if (error) {
    /**
     * 23505 is duels_one_bot_draft_per_player (migration 0015): this manager already has a
     * practice draft open — a double press, or two tabs. The room that won is the answer.
     */
    if (error.code === '23505') {
      const existing = await liveDuelFor(db, profileId);
      if (existing) return existing;
    }
    throw createError({ statusCode: 500, statusMessage: error.message });
  }

  await db.from('duel_queue').delete().eq('profile_id', profileId);

  /**
   * Check after, not only before.
   *
   * bot.post.ts looks for a live room first, but between that read and this insert a queue
   * pairing or an accepted challenge can open one — and then this manager is in two rooms,
   * one of which drafts itself while they play the other. The index above stops two practice
   * drafts; this stops the mixed case. Whichever room is older stands, and a bot room has
   * nobody else in it, so deleting the newer one costs nobody anything.
   */
  const rooms = await liveDuelsFor(db, profileId);
  if (rooms.length > 1 && rooms[0]!.id !== data.id) {
    await db.from('duels').delete().eq('id', data.id).eq('status', 'DRAFTING').eq('turn', 0);
    return rooms[0]!.id;
  }
  return data.id;
}
