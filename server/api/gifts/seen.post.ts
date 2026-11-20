import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';

/**
 * Mark the arrival of a gift as announced.
 *
 * This is only about the one-time toast. The gift itself stays waiting — and stays visible
 * on the pack screen and in the shop — until it is opened, because a notification that
 * disappears and takes a free pack with it is worse than no notification.
 *
 * Only ever moves `seen_at` forward from null, so a second call cannot rewrite history, and
 * only ever touches rows belonging to the manager who asked.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const body = await readBody<{ ids?: string[] }>(event);
  const ids = Array.isArray(body?.ids) ? body!.ids!.map(String).filter(Boolean) : null;

  let query = db
    .from('pack_gifts')
    .update({ seen_at: new Date().toISOString() })
    .eq('profile_id', profileId)
    .is('seen_at', null)
    .is('opened_at', null);

  if (ids && ids.length) query = query.in('id', ids);

  const { data, error } = await query.select('id');
  if (error) throw createError({ statusCode: 500, statusMessage: error.message });

  return { seen: (data || []).length };
});
