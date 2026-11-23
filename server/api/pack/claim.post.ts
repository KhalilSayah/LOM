import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { configuredWindow } from '~~/server/utils/packDay';
import { rollOpening, type PackType } from '~~/server/utils/roll';
import {
  openPack, dailyState, loadPackType, activeCatalogueId, STREAK_FLOOR, type OpenResult,
} from '~~/server/utils/openPack';

/**
 * Open a daily pack: the oldest one waiting.
 *
 * Packs bank (docs/02 section 5.1): today's, and any of the previous two pack days' that
 * were not opened. They open oldest first, because the oldest is the one that would be lost
 * first.
 *
 * The lock is in the database. `lom_open_pack` reserves the (profile, pack_day) claim and
 * settles it in the same transaction it grants the cards in, under a lock on the profile
 * row, so two taps queue up and the second finds the claim settled. There is no half-opened
 * state left behind to resume: if anything fails, nothing happened, and the same pack is
 * still waiting. That is also the "Finish opening" path for a claim reserved by older code.
 *
 * The seventh day in a row's first pack is upgraded: one card, Epic or better.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const config = useRuntimeConfig();
  const db = serverSupabaseServiceRole(event);
  const window = configuredWindow(config);
  const profileId = await ensureProfile(db, manager);

  const catalogueVersionId = await activeCatalogueId(db);
  const daily = await loadPackType(db, 'DAILY');
  if (!daily) {
    throw createError({
      statusCode: 503,
      statusMessage: 'No DAILY pack type. Run supabase/migrations/0004_credits_and_packs.sql.',
    });
  }

  let state = await dailyState(db, profileId, window);
  let result: OpenResult | null = null;
  let bonus = false;

  // At most a couple of passes: one for a day that settled under us, one for a streak
  // upgrade another tap has already used.
  for (let attempt = 0; attempt < 3 && !result; attempt++) {
    const day = state.bank[0];
    if (!day) {
      throw createError({ statusCode: 409, statusMessage: 'No pack waiting. The next one lands at the day roll.' });
    }

    bonus = state.nextIsBonus;
    const pack: PackType = bonus ? { ...daily, floor_band: STREAK_FLOOR } : daily;
    const { picks } = await rollOpening({ db, profileId, catalogueVersionId, pack });

    const opened = await openPack({
      db, profileId, source: 'DAILY', pack, picks,
      packDay: day, openedDay: window.packDay, bonus,
    });

    if (opened.status === 'opened') {
      result = opened;
    } else {
      state = await dailyState(db, profileId, window);
      if (opened.status === 'bonus_taken') state = { ...state, nextIsBonus: false };
    }
  }

  if (!result) throw createError({ statusCode: 409, statusMessage: 'That pack was opened a moment ago.' });

  const after = await dailyState(db, profileId, window);
  const first = result.cards[0];

  return {
    packDay: window.packDay,
    packType: 'DAILY',
    rarity: first?.rarity ?? null,
    forcedBy: first?.forcedBy ?? null,
    wasDuplicate: first?.wasDuplicate ?? false,
    xpAwarded: first?.xpAwarded ?? 0,
    creditsEarned: result.creditsEarned,
    credits: result.credits,
    card: first?.card ?? null,
    cards: result.cards,
    streakBonus: bonus,
    streak: after.streak,
    streakDay: after.streakDay,
    waiting: after.bank.length,
  };
});
