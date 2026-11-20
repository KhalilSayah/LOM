import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';

/**
 * Stop searching.
 *
 * Deliberately unconditional and deliberately silent about what it found. If the row has
 * already been paired, deleting it changes nothing — the duel exists and the client is about
 * to be told about it by the room itself — and refusing here would mean a Cancel button that
 * sometimes does not cancel.
 *
 * Also called on the way into a room, by the client that was paired, to tidy up after
 * itself.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  await db.from('duel_queue').delete().eq('profile_id', profileId);
  return { ok: true };
});
