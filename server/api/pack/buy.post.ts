import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { configuredWindow } from '~~/server/utils/packDay';
import { rollOpening } from '~~/server/utils/roll';
import { openPack, loadPackType, activeCatalogueId } from '~~/server/utils/openPack';

/**
 * Buy and open a pack.
 *
 * The pack is rolled first, because a roll has no side effects. Then `lom_open_pack` does
 * everything that does have one in a single transaction under a lock on the profile row:
 * it counts today's openings against the pack's daily limit, spends the price, and grants
 * the cards. So the limit cannot be beaten by two taps, and a pack cannot be paid for
 * without arriving — if any part fails, the spend is rolled back with it, and no refund is
 * needed because nothing was ever taken.
 *
 * The checks below are only for a friendly message before the roll; the database is the
 * authority on both.
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
    throw createError({ statusCode: 400, statusMessage: 'The daily pack is free — open it on Home.' });
  }

  const pack = await loadPackType(db, key, true);
  if (!pack) throw createError({ statusCode: 404, statusMessage: 'No such pack' });

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

  const catalogueVersionId = await activeCatalogueId(db);
  const { picks } = await rollOpening({ db, profileId, catalogueVersionId, pack });

  const result = await openPack({
    db, profileId, source: 'BUY', pack, picks, packDay: window.packDay,
  });

  if (result.status !== 'opened') {
    throw createError({ statusCode: 409, statusMessage: 'The pack did not open. Nothing was spent; try again.' });
  }

  return {
    packType: pack.key,
    packName: pack.name,
    spent: result.spent,
    creditsEarned: result.creditsEarned,
    credits: result.credits,
    cards: result.cards,
  };
});
