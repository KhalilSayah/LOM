import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { CARD_SELECT, toCard } from '~~/shared/cardShape';
import { ROLES, chemistryFor } from '~~/shared/roster';
import { simulate } from '~~/packages/sim/src/index.js';
import { effRating } from '~~/packages/core/src/index.js';
import { TEAM_A, TEAM_B } from '~~/packages/sim/fixtures/teams.mjs';

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
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  await ensureProfile(db, manager);

  const query = getQuery(event);
  const seed = String(query.seed || `sandbox-${Date.now()}`);
  const useRoster = query.roster !== '0';

  const mine = useRoster ? await rosterTeam(db, manager.id) : null;

  const blue = mine?.team || { ...TEAM_A, managerId: manager.id };
  const red = { ...TEAM_B };

  const result = simulate({ seed, blue, red });

  return {
    seed,
    source: mine ? 'ROSTER' : 'FIXTURE',
    missing: mine ? [] : (useRoster ? await emptySlots(db, manager.id) : []),
    blueName: mine ? 'Your roster' : 'T1 2024',
    redName: 'BLG 2024',
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
 * There is no draft yet, so each card plays the champion it is best at: the deepest
 * mastery in its pool. That is the same assumption the roster screen's pool-depth
 * number makes, and it is the one that flatters nobody — a card with a shallow pool
 * walks in on a champion it barely knows and the rating reflects it.
 */
async function rosterTeam(db: any, profileId: string) {
  const { data: slots } = await db
    .from('roster_slots')
    .select('role, collection_card_id')
    .eq('profile_id', profileId);

  if (!slots || slots.length < ROLES.length) return null;

  const { data: owned } = await db
    .from('collection_cards')
    .select(`id, level, card_definitions ( ${CARD_SELECT} )`)
    .in('id', slots.map((s: any) => s.collection_card_id));

  const byId = new Map((owned || []).map((row: any) => [row.id, row]));
  const cards: Record<string, any> = {};
  const players = [];

  for (const slot of slots) {
    const row = byId.get(slot.collection_card_id);
    if (!row?.card_definitions) return null;

    const card = toCard(row.card_definitions);
    const best = [...card.championPool].sort((a: any, b: any) => b.mastery - a.mastery)[0];
    cards[slot.role] = card;

    players.push({
      cardKey: card.cardKey,
      name: card.playerName,
      slot: slot.role,
      champion: best?.champion || null,
      mastery: best?.mastery ?? 0,
      effRating: effRating({
        ovr: card.ovr,
        level: row.level,
        mastery: best?.mastery ?? 0,
        championRole: card.role,
        slot: slot.role,
      }),
      subStats: card.subStats,
      chemistry: 0,
    });
  }

  // Chemistry is a property of the five together, so it is resolved once the whole
  // lineup is known and then written onto each player the engine sees.
  const chemistry = chemistryFor(cards as any);
  for (const player of players) {
    player.chemistry = chemistry.byRole[player.slot]?.bonus ?? 0;
  }

  return {
    team: {
      managerId: profileId,
      strategy: 'STANDARD',
      coach: null,
      players: players.sort((a, b) => ROLES.indexOf(a.slot as any) - ROLES.indexOf(b.slot as any)),
    },
  };
}
