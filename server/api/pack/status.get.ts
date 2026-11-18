import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager } from '~~/server/utils/auth';
import { configuredWindow } from '~~/server/utils/packDay';
import { PITY } from '~~/server/utils/roll';
import { CARD_SELECT, toCard } from '~~/shared/cardShape';

/**
 * Where this manager stands: is a pack waiting, when does the next one land, and how close
 * is the pity counter. The client renders the countdown from `nextOpensAt`, which is an
 * instant, so no client clock or timezone has to agree with the server about anything but
 * the current time.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const config = useRuntimeConfig();
  const db = serverSupabaseServiceRole(event);
  const window = configuredWindow(config);

  const [{ data: claim }, { data: pity }, { count }, { data: catalogue }] = await Promise.all([
    db.from('pack_claims')
      .select(`pack_day, claimed_at, rarity, was_duplicate, xp_awarded,
               card_definitions ( ${CARD_SELECT} )`)
      .eq('profile_id', manager.id)
      .eq('pack_day', window.packDay)
      .maybeSingle(),
    db.from('pity_counters')
      .select('since_legendary, since_icon, packs_opened')
      .eq('profile_id', manager.id)
      .maybeSingle(),
    db.from('collection_cards')
      .select('id', { count: 'exact', head: true })
      .eq('profile_id', manager.id),
    db.from('catalogue_versions')
      .select('semver')
      .eq('is_active', true)
      .maybeSingle(),
  ]);

  const counters = pity || { since_legendary: 0, since_icon: 0, packs_opened: 0 };
  const card = claim?.card_definitions ? toCard(claim.card_definitions as any) : null;

  return {
    packDay: window.packDay,
    opensAt: window.opensAt.toISOString(),
    nextOpensAt: window.nextOpensAt.toISOString(),
    serverNow: new Date().toISOString(),
    hour: window.hour,
    timeZone: window.timeZone,
    catalogue: catalogue?.semver ?? null,
    // Nothing to roll against yet: the UI explains that instead of offering a button that
    // fails at the endpoint.
    available: !claim && Boolean(catalogue),
    claim: claim
      ? {
          claimedAt: claim.claimed_at,
          rarity: claim.rarity,
          wasDuplicate: claim.was_duplicate,
          xpAwarded: claim.xp_awarded,
          card,
        }
      : null,
    pity: {
      sinceLegendary: counters.since_legendary,
      sinceIcon: counters.since_icon,
      packsOpened: counters.packs_opened,
      legendaryIn: Math.max(0, PITY.legendary - counters.since_legendary),
      iconIn: Math.max(0, PITY.icon - counters.since_icon),
    },
    collectionCount: count ?? 0,
  };
});
