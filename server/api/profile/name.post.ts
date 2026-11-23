import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { readOwnProfile, isMissingColumn } from '~~/server/utils/profileRow';
import { normaliseHandle, handleProblem, cleanName, DISPLAY_MAX, TEAM_MAX } from '~~/shared/names';
import { allowHit, tooMany } from '~~/server/utils/rateLimit';

/**
 * Choose, or change, the names you play under.
 *
 * The only way a profile's names change. Direct client updates on `profiles` are revoked
 * (a manager could otherwise write any column RLS let them reach), so this route holds the
 * service-role key and writes exactly three columns it has validated itself, plus the
 * `handle_chosen` flag that tells the door the name step is done.
 *
 * Body: { handle, displayName?, teamName? }. An empty display name falls back to the
 * handle; an empty team name is stored as null, and leagues then use the display name.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  if (!allowHit(`name:${manager.id}`, 20, 10 * 60_000)) tooMany();

  const db = serverSupabaseServiceRole(event);
  await ensureProfile(db, manager);

  const current = await readOwnProfile(db, manager.id);
  if (!current) throw createError({ statusCode: 404, statusMessage: 'Your profile could not be found.' });

  const body = await readBody<{ handle?: unknown; displayName?: unknown; teamName?: unknown }>(event)
    .catch(() => null);

  const handle = normaliseHandle(body?.handle ?? current.handle);
  if (handle !== current.handle) {
    const problem = handleProblem(handle);
    if (problem) throw createError({ statusCode: 400, statusMessage: problem });
  }

  const displayName = cleanName(body?.displayName, DISPLAY_MAX) || handle;
  const teamName = cleanName(body?.teamName, TEAM_MAX) || null;

  const patch: Record<string, unknown> = {
    handle,
    display_name: displayName,
    team_name: teamName,
    handle_chosen: true,
  };

  let { error } = await db.from('profiles').update(patch).eq('id', manager.id);

  // Migration 0020 not run yet: write the names that have columns, skip the rest.
  if (isMissingColumn(error)) {
    ({ error } = await db.from('profiles')
      .update({ handle, display_name: displayName })
      .eq('id', manager.id));
  }

  if (error) {
    if (error.code === '23505') {
      throw createError({ statusCode: 409, statusMessage: 'Somebody already has that name. Pick another.' });
    }
    if (error.code === '23514') {
      throw createError({ statusCode: 400, statusMessage: 'That name is not allowed. Letters, numbers and underscores, 3 to 20.' });
    }
    console.error(`[profile] name update failed: ${error.message}`);
    throw createError({ statusCode: 500, statusMessage: 'Your name could not be saved. Try again.' });
  }

  return { profile: await readOwnProfile(db, manager.id) };
});
