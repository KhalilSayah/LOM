import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { rollOpening, type PackType } from '~~/server/utils/roll';
import { persistOpening } from '~~/server/utils/openPack';

/**
 * Open a gifted pack.
 *
 * The lock is the `opened_at` update: the row is claimed with
 * `update ... where opened_at is null` *before* anything is rolled, and PostgREST returns
 * the rows it actually changed, so two taps race on that update and exactly one gets a row.
 * The loser gets a 409 rather than a second pack.
 *
 * If the roll then fails, the claim is released, which is the opposite trade to the daily
 * pack: `pack_claims` keeps its reservation because the day itself is the entitlement and a
 * half-finished claim can be resumed, whereas a gift is a one-off that nothing else would
 * ever retry. Better to hand it back than to swallow it.
 *
 * `pack_day` is deliberately left null on the opening. A gift is not part of the day's
 * allowance: being given a Standard pack should not cost a manager one of the two they can
 * buy. The pack still advances pity like every other, which docs/02 section 5.1.1 requires.
 *
 * Everything runs with the service-role key, because a client that could write
 * pack_openings or collection_cards would not need a gift in the first place.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const body = await readBody<{ id?: string }>(event).catch(() => ({} as { id?: string }));
  const giftId = String(body?.id ?? '').trim();

  // 1. Find the gift to open: the one asked for, or the oldest still waiting.
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

  // 2. Claim it. This is the point at which a second tap loses.
  const { data: claimed, error: claimError } = await db
    .from('pack_gifts')
    .update({ opened_at: new Date().toISOString(), seen_at: new Date().toISOString() })
    .eq('id', found.id)
    .is('opened_at', null)
    .select('id, pack_type')
    .maybeSingle();

  if (claimError) throw createError({ statusCode: 500, statusMessage: claimError.message });
  if (!claimed) throw createError({ statusCode: 409, statusMessage: 'That gift is already open.' });

  /** Hand the gift back, so a failure here does not quietly cost somebody a pack. */
  const release = async () => {
    await db.from('pack_gifts').update({ opened_at: null }).eq('id', claimed.id);
  };

  try {
    const { data: packRow } = await db
      .from('pack_types')
      .select('key, name, price, slots, one_per_role, weights, floor_band, max_band, daily_limit')
      .eq('key', claimed.pack_type)
      .maybeSingle();

    if (!packRow) {
      throw createError({ statusCode: 503, statusMessage: `No ${claimed.pack_type} pack type.` });
    }

    const { data: active } = await db
      .from('catalogue_versions')
      .select('id')
      .eq('is_active', true)
      .maybeSingle();

    if (!active) {
      throw createError({ statusCode: 503, statusMessage: 'No active catalogue. Run scripts/push-catalogue.mjs.' });
    }

    const pack = packRow as unknown as PackType;
    const { picks, pity } = await rollOpening({
      db,
      profileId,
      catalogueVersionId: active.id,
      pack,
    });

    const { openingId, cards, creditsEarned } = await persistOpening({
      db,
      profileId,
      pack,
      picks,
      pity,
      packDay: null,
      creditsSpent: 0,
    });

    await db.from('pack_gifts').update({ opening_id: openingId }).eq('id', claimed.id);

    const { data: profile } = await db.from('profiles').select('credits').eq('id', profileId).single();

    return {
      giftId: claimed.id,
      packType: pack.key,
      packName: pack.name,
      spent: 0,
      creditsEarned,
      credits: profile?.credits ?? 0,
      cards,
    };
  } catch (e) {
    await release();
    throw e;
  }
});
