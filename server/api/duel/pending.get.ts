import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { liveDuelFor } from '~~/server/utils/duelQueue';

/**
 * Counts only: how many challenges are waiting on you, and how many drafts are live.
 *
 * Separate from /api/duel/list because this one is polled from the nav on every screen.
 * The list endpoint joins profiles and shapes every duel the manager has ever played,
 * which is a lot of work to decide whether to draw a dot.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const [{ count: incoming }, liveId] = await Promise.all([
    db.from('duels')
      .select('id', { count: 'exact', head: true })
      .eq('opponent_id', profileId)
      .eq('status', 'PENDING'),
    /**
     * A live room is a draft or a match still playing, and unlike a count it comes back with
     * an id. That matters: a room you are in is somewhere you should be put back rather than
     * merely told about, so the nav links straight to it.
     *
     * Through liveDuelFor rather than its own query, so there is one definition of "live".
     * Two of them disagreed by exactly the twenty-second result grace, which is long enough
     * for the nav to keep offering to send somebody back into a match they have finished
     * watching.
     */
    liveDuelFor(db, profileId),
  ]);

  return {
    incoming: incoming ?? 0,
    drafting: liveId ? 1 : 0,
    liveDuelId: liveId,
  };
});
