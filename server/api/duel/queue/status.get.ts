import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { liveDuelFor, waitingCount } from '~~/server/utils/duelQueue';

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

  const [{ data: mine }, live] = await Promise.all([
    db.from('duel_queue').select('joined_at, duel_id').eq('profile_id', profileId).maybeSingle(),
    liveDuelFor(db, profileId),
  ]);

  return {
    searching: Boolean(mine && !mine.duel_id),
    since: mine?.joined_at ?? null,
    // A paired row beats a live duel lookup only in that it is the newer fact; both point at
    // the same room when both exist.
    duelId: mine?.duel_id ?? live ?? null,
    waiting: await waitingCount(db, profileId),
    serverNow: new Date().toISOString(),
  };
});
