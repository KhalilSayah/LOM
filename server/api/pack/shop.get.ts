import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { configuredWindow } from '~~/server/utils/packDay';
import { PITY } from '~~/server/utils/roll';

/**
 * What the manager can buy, what it costs, and what it can produce.
 *
 * The odds go to the client in full. docs/02 section 5.2 makes that argument about pity —
 * hidden pity is just anxiety — and it applies at least as strongly to a pack someone is
 * about to spend Credits on.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);
  const window = configuredWindow(useRuntimeConfig());

  const [{ data: packs }, { data: profile }, { data: todays }, { data: pity }] = await Promise.all([
    db.from('pack_types')
      .select('key, name, blurb, price, slots, one_per_role, weights, floor_band, max_band, daily_limit, sort')
      .eq('is_active', true)
      .order('sort'),
    db.from('profiles').select('credits').eq('id', profileId).single(),
    db.from('pack_openings')
      .select('pack_type')
      .eq('profile_id', profileId)
      .eq('pack_day', window.packDay),
    db.from('pity_counters')
      .select('since_legendary, since_icon')
      .eq('profile_id', profileId)
      .maybeSingle(),
  ]);

  const openedToday = new Map<string, number>();
  for (const row of todays || []) {
    openedToday.set(row.pack_type, (openedToday.get(row.pack_type) || 0) + 1);
  }

  const credits = profile?.credits ?? 0;

  const since = { legendary: pity?.since_legendary ?? 0, icon: pity?.since_icon ?? 0 };

  return {
    credits,
    // The same counters Home shows. They override any pack's own odds, ceiling included.
    pity: {
      legendaryIn: Math.max(0, PITY.legendary - since.legendary),
      iconIn: Math.max(0, PITY.icon - since.icon),
      legendaryEvery: PITY.legendary,
      iconEvery: PITY.icon,
    },
    packs: (packs || [])
      // The free daily pack has its own screen and its own once-a-day lock; it is not for sale.
      .filter((p) => p.key !== 'DAILY')
      .map((p) => {
        const used = openedToday.get(p.key) || 0;
        const remaining = p.daily_limit == null ? null : Math.max(0, p.daily_limit - used);
        return {
          ...p,
          openedToday: used,
          remainingToday: remaining,
          affordable: credits >= p.price,
          canBuy: credits >= p.price && (remaining == null || remaining > 0),
        };
      }),
  };
});
