import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { configuredWindow } from '~~/server/utils/packDay';
import { rollOpening, type PackType } from '~~/server/utils/roll';
import { persistOpening } from '~~/server/utils/openPack';

/**
 * Claim today's pack.
 *
 * The concurrency story is the unique index on (profile_id, pack_day): the row is inserted
 * *before* anything is rolled, so two taps race on the insert and exactly one proceeds. A
 * claim whose roll did not finish has settled_at = null and is resumed on the next call,
 * which is why the insert and the roll are not wrapped in one optimistic check.
 *
 * Everything here runs with the service-role key. There is no client-side insert policy on
 * collection_cards, so this endpoint is the only way a card can enter a collection.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const config = useRuntimeConfig();
  const db = serverSupabaseServiceRole(event);
  const window = configuredWindow(config);

  // pack_claims and collection_cards both point at profiles, so the row has to exist
  // before anything is rolled.
  const profileId = await ensureProfile(db, manager);

  const { data: active } = await db
    .from('catalogue_versions')
    .select('id, semver')
    .eq('is_active', true)
    .maybeSingle();

  if (!active) {
    throw createError({
      statusCode: 503,
      statusMessage: 'No active catalogue. Run scripts/push-catalogue.mjs.',
    });
  }

  // 1. Reserve the day.
  const { data: reserved, error: reserveError } = await db
    .from('pack_claims')
    .insert({ profile_id: profileId, pack_day: window.packDay })
    .select('id, settled_at')
    .single();

  let claimId = reserved?.id as string | undefined;

  if (reserveError) {
    if (reserveError.code !== '23505') {
      throw createError({ statusCode: 500, statusMessage: reserveError.message });
    }
    const { data: existing } = await db
      .from('pack_claims')
      .select('id, settled_at')
      .eq('profile_id', profileId)
      .eq('pack_day', window.packDay)
      .single();

    if (existing?.settled_at) {
      throw createError({ statusCode: 409, statusMessage: 'Today’s pack is already open' });
    }
    claimId = existing?.id;
  }

  if (!claimId) throw createError({ statusCode: 500, statusMessage: 'Could not reserve the pack' });

  // 2. Roll and settle, through the same path a bought pack takes. The daily pack is a
  // one-slot pack whose price is zero; nothing about it needs its own copy of the rules.
  const { data: packRow } = await db
    .from('pack_types')
    .select('key, name, price, slots, one_per_role, weights, floor_band, max_band, daily_limit')
    .eq('key', 'DAILY')
    .maybeSingle();

  if (!packRow) {
    throw createError({
      statusCode: 503,
      statusMessage: 'No DAILY pack type. Run supabase/migrations/0004_credits_and_packs.sql.',
    });
  }

  const pack = packRow as unknown as PackType;
  const { picks, pity } = await rollOpening({ db, profileId, catalogueVersionId: active.id, pack });
  const { openingId, cards, creditsEarned } = await persistOpening({
    db,
    profileId,
    pack,
    picks,
    pity,
    packDay: window.packDay,
    creditsSpent: 0,
  });

  const first = cards[0];
  const firstPick = picks[0];

  // 3. Settle the claim. pack_claims still carries the single card it always did, so the
  // day's lock and anything reading it keep working; the opening holds the full story.
  await db.from('pack_claims').update({
    card_definition_id: firstPick ? firstPick.cardId : null,
    rarity: first?.rarity ?? null,
    was_duplicate: first?.wasDuplicate ?? false,
    xp_awarded: first?.xpAwarded ?? 0,
    opening_id: openingId,
    settled_at: new Date().toISOString(),
  }).eq('id', claimId);

  const { data: profile } = await db.from('profiles').select('credits').eq('id', profileId).single();

  return {
    packDay: window.packDay,
    packType: pack.key,
    rarity: first?.rarity ?? null,
    forcedBy: first?.forcedBy ?? null,
    wasDuplicate: first?.wasDuplicate ?? false,
    xpAwarded: first?.xpAwarded ?? 0,
    creditsEarned,
    credits: profile?.credits ?? 0,
    card: first?.card ?? null,
    cards,
  };
});
