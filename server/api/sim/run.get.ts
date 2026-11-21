import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { CARD_SELECT, toCard } from '~~/shared/cardShape';
import { ROLES, matchRatingFor } from '~~/shared/roster';
import { simulate, configureChampionData } from '~~/packages/sim/src/index.js';
import { TEAM_A, TEAM_B } from '~~/packages/sim/fixtures/teams.mjs';
import { strategyFor } from '~~/server/utils/strategy';
import { activeChampionRoles, withFitRoles } from '~~/server/utils/rosterFit';
import championTable from '~~/data/champions.json';

// Same as server/utils/duel.ts: without the champion table the composition modifier is a
// flat 1.0, and the sandbox would be a different game from the one duels play.
configureChampionData((championTable as any).champions);

/**
 * Run one match and hand back the whole thing.
 *
 * On the server because that is where it belongs the moment matches count for
 * anything (docs/06): the seed, the engine version and the result are the record,
 * and a client that can run its own simulation can run a different one. Today it is
 * a sandbox, so the only thing that makes it a sandbox is that nothing is stored.
 *
 * It fields the manager's own roster when it is complete, because watching a match
 * is a different thing when the five dots are cards you opened. If any slot is
 * empty, both sides come from the fixtures and the response says so.
 *
 * Either way the blue side plays the manager's strategy preset (migration 0018).
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  await ensureProfile(db, manager);

  const query = getQuery(event);
  const seed = String(query.seed || `sandbox-${Date.now()}`);
  const useRoster = query.roster !== '0';

  const [mine, strategy] = await Promise.all([
    useRoster ? rosterTeam(db, manager.id) : null,
    strategyFor(db, manager.id),
  ]);

  const blue = { ...(mine?.team || { ...TEAM_A, managerId: manager.id }), strategy };
  const red = { ...TEAM_B };

  const result = simulate({ seed, blue, red });

  return {
    seed,
    source: mine ? 'ROSTER' : 'FIXTURE',
    missing: mine ? [] : (useRoster ? await emptySlots(db, manager.id) : []),
    blueName: mine ? 'Your roster' : 'T1 2024',
    redName: 'BLG 2024',
    strategy,
    result,
  };
});

/** Which slots are empty, so the screen can say why it fell back. */
async function emptySlots(db: any, profileId: string) {
  const { data } = await db.from('roster_slots').select('role').eq('profile_id', profileId);
  const filled = new Set((data || []).map((r: any) => r.role));
  return ROLES.filter((role) => !filled.has(role));
}

/**
 * The manager's five, as the engine wants them.
 *
 * There is no draft in a sandbox, so each card plays the champion it is rated best on, with
 * no champion fielded twice — shared/roster.ts assignChampions, the same choice the Team
 * screen's match rating makes, so the number on that screen is the number this match reads.
 * Ratings are packages/core effRating with the card's level and the champion's own role
 * from the catalogue (server/utils/championRoles.ts), the way a duel rates a pick.
 */
async function rosterTeam(db: any, profileId: string) {
  const { data: slots } = await db
    .from('roster_slots')
    .select('role, collection_card_id')
    .eq('profile_id', profileId);

  if (!slots || slots.length < ROLES.length) return null;

  const [{ data: owned }, roles] = await Promise.all([
    db.from('collection_cards')
      .select(`id, level, card_definitions ( ${CARD_SELECT} )`)
      .in('id', slots.map((s: any) => s.collection_card_id)),
    activeChampionRoles(db),
  ]);

  const byId = new Map((owned || []).map((row: any) => [row.id, row]));
  const cards: Record<string, any> = {};

  for (const slot of slots) {
    const row: any = byId.get(slot.collection_card_id);
    if (!row?.card_definitions) return null;
    cards[slot.role] = withFitRoles(toCard(row.card_definitions, row.level), roles);
  }

  const rating = matchRatingFor(cards);
  const players = ROLES.map((role) => {
    const card = cards[role];
    const pick = rating.byRole[role]!;
    return {
      cardKey: card.cardKey,
      name: card.playerName,
      slot: role,
      champion: pick.champion,
      mastery: pick.mastery,
      effRating: pick.rating,
      subStats: card.subStats,
      chemistry: pick.chemistry,
    };
  });

  return {
    team: {
      managerId: profileId,
      strategy: 'STANDARD',
      coach: null,
      players,
    },
  };
}
