import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { configuredWindow } from '~~/server/utils/packDay';
import { questBoard } from '~~/server/utils/quests';

/** Today's three, this week's three, and how far along each one is. */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);
  const window = configuredWindow(useRuntimeConfig());

  const board = await questBoard(db, profileId, window);
  return { ...board, serverNow: new Date().toISOString() };
});
