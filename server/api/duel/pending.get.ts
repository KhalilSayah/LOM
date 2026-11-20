import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';

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

  const [{ count: incoming }, { data: live }] = await Promise.all([
    db.from('duels')
      .select('id', { count: 'exact', head: true })
      .eq('opponent_id', profileId)
      .eq('status', 'PENDING'),
    /**
     * A live room is a draft *or* a match being watched, and unlike a count it comes back
     * with an id. That matters now: a room you are in is somewhere you should be put back
     * rather than merely told about, so the nav links straight to it.
     */
    db.from('duels')
      .select('id, status')
      .in('status', ['DRAFTING', 'WATCHING'])
      .or(`challenger_id.eq.${profileId},opponent_id.eq.${profileId}`)
      .order('updated_at', { ascending: false })
      .limit(1),
  ]);

  const room = live?.[0] ?? null;

  return {
    incoming: incoming ?? 0,
    drafting: room ? 1 : 0,
    liveDuelId: room?.id ?? null,
    liveStatus: room?.status ?? null,
  };
});
