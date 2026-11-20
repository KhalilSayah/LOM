import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import {
  entryFor, liveDuelFor, matchmake, sweepQueue, waitingCount, clearSettledEntry,
} from '~~/server/utils/duelQueue';

/**
 * Press Battle.
 *
 * One button, and three things it can mean, which the response distinguishes:
 *
 *   { duelId }    — you are in a room. Go there now; so has the other person.
 *   { searching } — nobody else is here. Stay on this screen; realtime will push your queue
 *                   row the moment somebody pairs with you, and after a few seconds of that
 *                   the client offers the agent instead.
 *   4xx           — your roster is not ready, which is the only reason to refuse.
 *
 * This is also the only place that pairs, and it pairs on the way in rather than from a
 * background job. Two people searching means the second one's press is what puts them
 * together — there is nothing to schedule and nothing to wake up.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  // A player with a live room has not asked for a second one; they have lost the first.
  const live = await liveDuelFor(db, profileId);
  if (live) return { duelId: live, resumed: true };

  const entry = await entryFor(db, profileId);

  /**
   * Our own row first, because duel_matchmake trusts it.
   *
   * The function's first act is to return `mine.duel_id` if it is set, which is right while
   * that duel is live and wrong the moment it is not: pressing Battle after a game would
   * hand back the game that had just finished instead of starting a search. Clearing it here
   * means the pairing function never sees a row it should not believe.
   */
  await clearSettledEntry(db, profileId);

  // Then everyone else's: a ghost row left by somebody who closed the app would otherwise be
  // matched with, and the player on this end would wait out a whole draft against an agent
  // they did not ask for.
  await sweepQueue(db);

  const duelId = await matchmake(db, profileId, entry);
  if (duelId) {
    await db.from('duel_queue').delete().eq('profile_id', profileId);
    return { duelId, resumed: false };
  }

  return {
    duelId: null,
    searching: true,
    since: new Date().toISOString(),
    waiting: await waitingCount(db, profileId),
  };
});
