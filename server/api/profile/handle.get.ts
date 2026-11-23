import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager } from '~~/server/utils/auth';
import { normaliseHandle, handleProblem } from '~~/shared/names';
import { allowHit, tooMany } from '~~/server/utils/rateLimit';

/**
 * Is this handle free? Answers as you type in the name step and in Settings, so a taken
 * name is said before the button is pressed rather than after. Your own current handle
 * counts as free.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  if (!allowHit(`handle:${manager.id}`, 60, 60_000)) tooMany();

  const handle = normaliseHandle(getQuery(event).h);
  const problem = handleProblem(handle);
  if (problem) return { handle, available: false, reason: problem };

  const db = serverSupabaseServiceRole(event);
  const { data } = await db.from('profiles').select('id').eq('handle', handle).maybeSingle();

  const available = !data || data.id === manager.id;
  return { handle, available, reason: available ? null : 'Somebody already has that name.' };
});
