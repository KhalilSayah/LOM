import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { readOwnProfile } from '~~/server/utils/profileRow';

/** The signed-in manager's own names and share code, for Profile, Settings and the name step. */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  await ensureProfile(db, manager);

  const profile = await readOwnProfile(db, manager.id);
  if (!profile) throw createError({ statusCode: 404, statusMessage: 'Your profile could not be found.' });

  return { profile, email: manager.email };
});
