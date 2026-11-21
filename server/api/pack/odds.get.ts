import { serverSupabaseServiceRole } from '#supabase/server';
import { configuredWindow, BANK_MAX } from '~~/server/utils/packDay';
import { PITY, PITY_ICON_SHARE, ROLE_BIAS, DUPLICATE_XP, DUPLICATE_CREDITS } from '~~/server/utils/roll';
import { STREAK_LENGTH, STREAK_FLOOR } from '~~/server/utils/openPack';

/**
 * Every rule behind a pack, in one answer, for the odds page.
 *
 * Read from the same constants and the same pack_types rows the roll uses, so the page
 * cannot drift from what actually happens. Public: none of it is a secret, and docs/02
 * section 5.2 is explicit that hiding odds and pity is just anxiety.
 */
export default defineEventHandler(async (event) => {
  const db = serverSupabaseServiceRole(event);
  const window = configuredWindow(useRuntimeConfig());

  const { data: packs } = await db
    .from('pack_types')
    .select('key, name, blurb, price, slots, one_per_role, weights, floor_band, max_band, daily_limit, sort')
    .eq('is_active', true)
    .order('sort');

  return {
    packs: packs || [],
    pity: {
      legendary: PITY.legendary,
      icon: PITY.icon,
      iconShareOnLegendaryPity: PITY_ICON_SHARE,
    },
    roleBias: ROLE_BIAS,
    duplicate: { xp: DUPLICATE_XP, credits: DUPLICATE_CREDITS },
    daily: {
      hour: window.hour,
      timeZone: window.timeZone,
      nextOpensAt: window.nextOpensAt.toISOString(),
      bankMax: BANK_MAX,
      streakLength: STREAK_LENGTH,
      streakFloor: STREAK_FLOOR,
    },
  };
});
