import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { liveDuelFor, waitingCount, clearSettledEntry } from '~~/server/utils/duelQueue';

/**
 * Where the search stands.
 *
 * The realtime subscription on the player's own queue row is what normally tells them they
 * have been paired, so this endpoint is not in the fast path. It is the resync: called once
 * when the Battle screen opens, and again if the channel ever reports itself closed. Same
 * reasoning as docs/05 section 5.2 — realtime is an accelerator over something pollable, not
 * the source of truth.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  /**
   * The Battle screen navigates straight into whatever `duelId` this returns, so it must
   * only ever be a room worth being in. A row left over from a game that has already
   * finished is not one, and sending somebody back into it is what made duels look like they
   * were relaunching themselves.
   */
  await clearSettledEntry(db, profileId);

  const [{ data: mine }, live] = await Promise.all([
    db.from('duel_queue').select('joined_at, duel_id').eq('profile_id', profileId).maybeSingle(),
    liveDuelFor(db, profileId),
  ]);

  return {
    searching: Boolean(mine && !mine.duel_id),
    since: mine?.joined_at ?? null,
    /**
     * Only a live room. `liveDuelFor` already filters on status, and the queue row has just
     * been checked against the same rule, so either source is now safe — but the live lookup
     * goes first because it is the one that cannot be stale.
     */
    duelId: live ?? mine?.duel_id ?? null,
    waiting: await waitingCount(db, profileId),
    serverNow: new Date().toISOString(),
  };
});
