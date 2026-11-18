import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager } from '~~/server/utils/auth';
import { managerByCode } from '~~/server/utils/discovery';

/**
 * Drop a manager from your discovery list.
 *
 * Forgetting is not blocking and does not reach them: the code still works, and
 * searching it again puts the widget back. It exists so a list collected over months
 * stays the people you actually look at.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);

  const body = await readBody<{ code?: string }>(event);
  const found = await managerByCode(db, body?.code);

  const { error } = await db
    .from('discoveries')
    .delete()
    .eq('seeker_id', manager.id)
    .eq('found_id', found.id);

  if (error) throw createError({ statusCode: 500, statusMessage: error.message });

  return { forgotten: found.shareCode };
});
