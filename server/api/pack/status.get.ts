import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { configuredWindow, BANK_MAX } from '~~/server/utils/packDay';
import { PITY } from '~~/server/utils/roll';
import { dailyState, cardsById, STREAK_LENGTH, STREAK_FLOOR } from '~~/server/utils/openPack';
import { questSummary } from '~~/server/utils/quests';

/**
 * Where this manager stands: how many daily packs are waiting, when the next one lands, the
 * streak, how close the pity counters are, and a line on today's quests.
 *
 * The client renders the countdown from `nextOpensAt`, which is an instant, so no client
 * clock or timezone has to agree with the server about anything but the current time. The
 * client formats that instant in the viewer's own timezone.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const config = useRuntimeConfig();
  const db = serverSupabaseServiceRole(event);
  const window = configuredWindow(config);
  const profileId = await ensureProfile(db, manager);

  const [state, { data: pity }, { count }, { data: catalogue }, { data: profile }, quests] = await Promise.all([
    dailyState(db, profileId, window),
    db.from('pity_counters')
      .select('since_legendary, since_icon, packs_opened')
      .eq('profile_id', profileId)
      .maybeSingle(),
    db.from('collection_cards')
      .select('id', { count: 'exact', head: true })
      .eq('profile_id', profileId),
    db.from('catalogue_versions')
      .select('semver')
      .eq('is_active', true)
      .maybeSingle(),
    db.from('profiles')
      .select('credits')
      .eq('id', profileId)
      .maybeSingle(),
    questSummary(db, profileId, window),
  ]);

  // Today's most recent pull, with what a duplicate paid.
  const latest = state.today[0] ?? null;
  let claim = null;
  if (latest) {
    const [defs, { data: slots }] = await Promise.all([
      cardsById(db, latest.cardId ? [latest.cardId] : []),
      latest.openingId
        ? db.from('pack_opening_cards').select('credits_awarded, xp_awarded').eq('opening_id', latest.openingId)
        : Promise.resolve({ data: [] as any[] }),
    ]);
    claim = {
      packDay: latest.packDay,
      rarity: latest.rarity,
      wasDuplicate: latest.wasDuplicate,
      xpAwarded: latest.xpAwarded,
      creditsAwarded: (slots || []).reduce((n: number, s: any) => n + (s.credits_awarded || 0), 0),
      streakBonus: latest.streakBonus,
      // Null when the card cannot be found (a catalogue rebuilt underneath it); the screen
      // says so rather than falling over.
      card: latest.cardId ? defs.get(latest.cardId) ?? null : null,
    };
  }

  const counters = pity || { since_legendary: 0, since_icon: 0, packs_opened: 0 };
  const waiting = catalogue ? state.bank.length : 0;

  return {
    packDay: window.packDay,
    opensAt: window.opensAt.toISOString(),
    nextOpensAt: window.nextOpensAt.toISOString(),
    serverNow: new Date().toISOString(),
    hour: window.hour,
    timeZone: window.timeZone,
    catalogue: catalogue?.semver ?? null,
    credits: profile?.credits ?? 0,
    // Nothing to roll against yet: the UI explains that instead of offering a button that
    // fails at the endpoint.
    available: waiting > 0,
    waiting,
    bankMax: BANK_MAX,
    /** True when today's own pack is among those waiting (the rest are banked from before). */
    todayWaiting: state.bank.includes(window.packDay),
    /** The next pack to open was started before and never finished; opening it finishes it. */
    resume: Boolean(state.bank[0] && state.reserved.includes(state.bank[0])),
    openedToday: state.today.length,
    claim,
    streak: {
      days: state.streak,
      openedToday: state.openedToday,
      day: state.streakDay,
      length: STREAK_LENGTH,
      nextIsBonus: state.nextIsBonus,
      bonusFloor: STREAK_FLOOR,
    },
    pity: {
      sinceLegendary: counters.since_legendary,
      sinceIcon: counters.since_icon,
      packsOpened: counters.packs_opened,
      legendaryIn: Math.max(0, PITY.legendary - counters.since_legendary),
      iconIn: Math.max(0, PITY.icon - counters.since_icon),
    },
    quests,
    collectionCount: count ?? 0,
  };
});
