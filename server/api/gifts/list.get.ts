import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { GIFT_SELECT, toGift, type GiftRow } from '~~/server/utils/gifts';

/**
 * The packs waiting for this manager, oldest first.
 *
 * Read by the layout on every signed-in page load, so it stays cheap and it never fails
 * loudly: a gift nobody has is an empty list, and a database that has not had migration
 * 0008 run against it is also an empty list rather than an error across every screen.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const { data, error } = await db
    .from('pack_gifts')
    .select(GIFT_SELECT)
    .eq('profile_id', profileId)
    .is('opened_at', null)
    .order('granted_at');

  if (error) {
    console.warn(`[gifts] could not list gifts: ${error.message}`);
    return { gifts: [], waiting: 0, unseen: 0 };
  }

  const gifts = ((data || []) as unknown as GiftRow[]).map(toGift);

  return {
    gifts,
    waiting: gifts.length,
    unseen: gifts.filter((g) => !g.seen).length,
  };
});
