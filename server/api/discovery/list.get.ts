import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { managersByIds, summariseCollections, EMPTY_SUMMARY } from '~~/server/utils/discovery';

/**
 * Everyone this manager has found, newest first, with their numbers.
 *
 * Also returns the seeker's own code, because the screen that lists other managers is
 * the screen where you hand yours out, and a second round trip for eight characters
 * the server already has in front of it is a flash of empty panel for nothing.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  await ensureProfile(db, manager);

  const [{ data: mine }, { data: rows, error }] = await Promise.all([
    db.from('profiles').select('handle, display_name, share_code').eq('id', manager.id).maybeSingle(),
    db.from('discoveries')
      .select('found_id, found_at')
      .eq('seeker_id', manager.id)
      .order('found_at', { ascending: false }),
  ]);

  if (error) throw createError({ statusCode: 500, statusMessage: error.message });

  const ids = (rows || []).map((r: any) => r.found_id);
  const [managers, summaries] = await Promise.all([
    managersByIds(db, ids),
    summariseCollections(db, ids),
  ]);

  const foundAt = new Map((rows || []).map((r: any) => [r.found_id, r.found_at]));

  return {
    me: {
      handle: mine?.handle ?? null,
      displayName: mine?.display_name ?? null,
      shareCode: mine?.share_code ?? null,
    },
    found: managers.map((m) => ({
      manager: m,
      collection: summaries.get(m.id) ?? EMPTY_SUMMARY,
      foundAt: foundAt.get(m.id) ?? null,
    })),
  };
});
