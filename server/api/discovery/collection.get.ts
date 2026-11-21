import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { managerByCode, summariseCollections, rememberDiscovery, readAll } from '~~/server/utils/discovery';
import { toCard } from '~~/shared/cardShape';

/**
 * Somebody else's collection, by code.
 *
 * Read-only and public-by-code: whoever holds the code sees the cards, the levels and
 * the duplicate counts, and nothing else about the account — no email, no pity
 * counter, no pack history. The shape is the same one the client's own collection
 * screen renders, so /m/[code] can reuse LomCard without a second card translation.
 *
 * Only what a grid tile, search and compare need is read: the season line, provenance and
 * accolade text belong to the card view, which /api/discovery/card serves one card at a
 * time. Rows are read a page at a time, because PostgREST stops at 1000 without saying so.
 *
 * Opening this also records the discovery, which is what makes a pasted code work
 * like a link: follow one and the manager is in your discovery list afterwards,
 * without having gone through the search field.
 */
const GRID_SELECT = `
  id, level, xp, copies, acquired_at,
  card_definitions (
    card_key, player_name, season, team, region, role, ovr, rarity,
    sub_stats, art_champion_key, art_focus,
    card_champion_pool ( champion_key, champion_name, games, winrate, mastery, slot )
  )
`;

export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  await ensureProfile(db, manager);

  const code = getQuery(event).code as string | undefined;
  const found = await managerByCode(db, code);
  const isSelf = found.id === manager.id;

  await rememberDiscovery(db, manager, found.id);

  const [rows, summaries] = await Promise.all([
    readAll<any>((from, to) => db
      .from('collection_cards')
      .select(GRID_SELECT)
      .eq('profile_id', found.id)
      .order('acquired_at', { ascending: false })
      .order('id')
      .range(from, to)),
    summariseCollections(db, [found.id]),
  ]);

  return {
    manager: found,
    isSelf,
    collection: summaries.get(found.id),
    cards: rows
      .filter((r: any) => r.card_definitions)
      .map((r: any) => ({
        id: r.id,
        level: r.level,
        xp: r.xp,
        copies: r.copies,
        acquiredAt: r.acquired_at,
        card: toCard(r.card_definitions),
      })),
  };
});
