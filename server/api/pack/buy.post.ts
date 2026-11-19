import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { configuredWindow } from '~~/server/utils/packDay';
import { rollOpening, type PackType } from '~~/server/utils/roll';
import { persistOpening, moveCredits } from '~~/server/utils/openPack';

/**
 * Buy and open a pack.
 *
 * The order matters. The pack is rolled *before* any Credits move, because a roll has no
 * side effects and a spend does: if the catalogue cannot satisfy the pack, the manager
 * should still have their Credits. Once the spend succeeds the cards are granted, and that
 * spend is a single locking SQL function, so two taps cannot both pay from the same balance.
 *
 * Everything runs with the service-role key. There is no client-side insert policy on
 * pack_openings or collection_cards, which is the point: a client that could write either
 * one could open a Legacy pack for nothing.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);
  const window = configuredWindow(useRuntimeConfig());

  const body = await readBody<{ packType?: string }>(event);
  const key = String(body?.packType ?? '').trim().toUpperCase();
  if (!key) throw createError({ statusCode: 400, statusMessage: 'Which pack?' });
  if (key === 'DAILY') {
    throw createError({ statusCode: 400, statusMessage: 'The daily pack is free — claim it instead.' });
  }

  const { data: pack } = await db
    .from('pack_types')
    .select('key, name, price, slots, one_per_role, weights, floor_band, max_band, daily_limit')
    .eq('key', key)
    .eq('is_active', true)
    .maybeSingle();

  if (!pack) throw createError({ statusCode: 404, statusMessage: 'No such pack' });

  // Per-day caps, counted off the openings themselves rather than a separate tally that
  // could drift away from them.
  if (pack.daily_limit != null) {
    const { count } = await db
      .from('pack_openings')
      .select('id', { count: 'exact', head: true })
      .eq('profile_id', profileId)
      .eq('pack_type', pack.key)
      .eq('pack_day', window.packDay);

    if ((count ?? 0) >= pack.daily_limit) {
      throw createError({
        statusCode: 429,
        statusMessage: `You have opened today's ${pack.name.toLowerCase()} allowance. Try again after the day rolls.`,
      });
    }
  }

  const { data: profile } = await db.from('profiles').select('credits').eq('id', profileId).single();
  if ((profile?.credits ?? 0) < pack.price) {
    throw createError({
      statusCode: 402,
      statusMessage: `That pack costs ${pack.price} Credits and you have ${profile?.credits ?? 0}.`,
    });
  }

  const { data: active } = await db
    .from('catalogue_versions')
    .select('id')
    .eq('is_active', true)
    .maybeSingle();

  if (!active) {
    throw createError({ statusCode: 503, statusMessage: 'No active catalogue. Run scripts/push-catalogue.mjs.' });
  }

  const { picks, pity } = await rollOpening({
    db,
    profileId,
    catalogueVersionId: active.id,
    pack: pack as unknown as PackType,
  });

  // The spend is the point of no return, and it is the thing that can still refuse: the SQL
  // function raises rather than overdrawing, which is what makes the check above advisory
  // and this authoritative.
  let balance: number;
  try {
    balance = await moveCredits(db, profileId, -pack.price, `PACK:${pack.key}`);
  } catch {
    throw createError({ statusCode: 402, statusMessage: 'Not enough Credits for that pack.' });
  }

  const { cards, creditsEarned } = await persistOpening({
    db,
    profileId,
    pack: pack as unknown as PackType,
    picks,
    pity,
    packDay: window.packDay,
    creditsSpent: pack.price,
  });

  return {
    packType: pack.key,
    packName: pack.name,
    spent: pack.price,
    creditsEarned,
    credits: balance + creditsEarned,
    cards,
  };
});
