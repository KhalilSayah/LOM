import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { cardsById } from '~~/server/utils/openPack';

/**
 * Every pack this manager has opened, newest first, with what came out of it.
 *
 * Read from pack_openings and pack_opening_cards, which record what each slot actually paid
 * (new card, or XP and Credits for a duplicate), so the history agrees with the ledger.
 */

const PAGE = 15;

export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const before = String(getQuery(event).before ?? '').trim();

  let query = db
    .from('pack_openings')
    .select('id, pack_type, credits_spent, opened_at, claim_id, gift_id, pack_types ( name ), pack_opening_cards ( slot, card_definition_id, rarity, was_duplicate, xp_awarded, credits_awarded )')
    .eq('profile_id', profileId)
    .order('opened_at', { ascending: false })
    .limit(PAGE + 1);
  if (before && !Number.isNaN(Date.parse(before))) query = query.lt('opened_at', before);

  const { data, error } = await query;
  if (error) throw createError({ statusCode: 500, statusMessage: error.message });

  const rows = (data || []).slice(0, PAGE) as any[];
  const defs = await cardsById(db, rows.flatMap((r) => (r.pack_opening_cards || []).map((c: any) => c.card_definition_id)));

  const openings = rows.map((r) => {
    const cards = ((r.pack_opening_cards || []) as any[])
      .slice()
      .sort((a, b) => a.slot - b.slot)
      .map((c) => ({
        slot: c.slot,
        rarity: c.rarity,
        wasDuplicate: c.was_duplicate,
        xpAwarded: c.xp_awarded,
        creditsAwarded: c.credits_awarded,
        card: defs.get(c.card_definition_id) ?? null,
      }));
    return {
      id: r.id,
      packType: r.pack_type,
      packName: r.pack_types?.name ?? r.pack_type,
      spent: r.credits_spent,
      at: r.opened_at,
      source: r.pack_type === 'DAILY' ? 'DAILY' : r.gift_id ? 'GIFT' : r.credits_spent > 0 ? 'BUY' : 'FREE',
      earned: cards.reduce((n, c) => n + (c.creditsAwarded || 0), 0),
      cards,
    };
  });

  return {
    openings,
    next: (data || []).length > PAGE ? openings[openings.length - 1]?.at ?? null : null,
  };
});
