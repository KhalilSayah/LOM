import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { rollOpening } from '~~/server/utils/roll';
import { openPack, loadPackType, activeCatalogueId } from '~~/server/utils/openPack';

/**
 * Open a gifted pack.
 *
 * The lock is the gift row itself, taken inside `lom_open_pack` (migration 0019) in the
 * same transaction that grants the cards and sets `opened_at`. Two taps queue up on that
 * lock and the second finds the gift open, so it gets a 409 rather than a second pack.
 *
 * Because the grant and the "opened" mark commit together, there is no failure that leaves
 * a gift both handed back and partly paid out: either every card arrived and the gift is
 * gone, or nothing arrived and the gift is still waiting to be opened again.
 *
 * `pack_day` is deliberately left null on the opening. A gift is not part of the day's
 * allowance: being given a Standard pack should not cost a manager one of the two they can
 * buy. The pack still advances pity like every other, which docs/02 section 5.1.1 requires.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const body = await readBody<{ id?: string }>(event).catch(() => ({} as { id?: string }));
  const giftId = String(body?.id ?? '').trim();

  // The one asked for, or the oldest still waiting.
  let waiting = db
    .from('pack_gifts')
    .select('id, pack_type, title')
    .eq('profile_id', profileId)
    .is('opened_at', null)
    .order('granted_at')
    .limit(1);

  if (giftId) waiting = waiting.eq('id', giftId);

  const { data: found, error: findError } = await waiting.maybeSingle();
  if (findError) throw createError({ statusCode: 500, statusMessage: findError.message });
  if (!found) throw createError({ statusCode: 404, statusMessage: 'No gift waiting to be opened.' });

  const pack = await loadPackType(db, found.pack_type);
  if (!pack) throw createError({ statusCode: 503, statusMessage: `No ${found.pack_type} pack type.` });

  const catalogueVersionId = await activeCatalogueId(db);
  const { picks } = await rollOpening({ db, profileId, catalogueVersionId, pack });

  const result = await openPack({
    db, profileId, source: 'GIFT', pack, picks, packDay: null, giftId: found.id,
  });

  if (result.status === 'missing') throw createError({ statusCode: 404, statusMessage: 'No gift waiting to be opened.' });
  if (result.status !== 'opened') throw createError({ statusCode: 409, statusMessage: 'That gift is already open.' });

  return {
    giftId: found.id,
    packType: pack.key,
    packName: pack.name,
    spent: 0,
    creditsEarned: result.creditsEarned,
    credits: result.credits,
    cards: result.cards,
  };
});
