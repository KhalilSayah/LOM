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

  const [{ count: incoming }, { count: drafting }] = await Promise.all([
    db.from('duels')
      .select('id', { count: 'exact', head: true })
      .eq('opponent_id', profileId)
      .eq('status', 'PENDING'),
    db.from('duels')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'DRAFTING')
      .or(`challenger_id.eq.${profileId},opponent_id.eq.${profileId}`),
  ]);

  return { incoming: incoming ?? 0, drafting: drafting ?? 0 };
});
