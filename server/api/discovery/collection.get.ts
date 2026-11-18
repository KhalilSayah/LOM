import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { managerByCode, summariseCollections, rememberDiscovery } from '~~/server/utils/discovery';
import { CARD_SELECT, toCard } from '~~/shared/cardShape';

/**
 * Somebody else's collection, by code.
 *
 * Read-only and public-by-code: whoever holds the code sees the cards, the levels and
 * the duplicate counts, and nothing else about the account — no email, no pity
 * counter, no pack history. The shape is the same one the client's own collection
 * screen renders, so /m/[code] can reuse LomCard without a second card translation.
 *
 * Opening this also records the discovery, which is what makes a pasted code work
 * like a link: follow one and the manager is in your discovery list afterwards,
 * without having gone through the search field.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  await ensureProfile(db, manager);

  const code = getQuery(event).code as string | undefined;
  const found = await managerByCode(db, code);
  const isSelf = found.id === manager.id;

  await rememberDiscovery(db, manager, found.id);

  const [{ data: rows, error }, summaries] = await Promise.all([
    db.from('collection_cards')
      .select(`id, level, xp, copies, acquired_at, card_definitions ( ${CARD_SELECT} )`)
      .eq('profile_id', found.id)
      .order('acquired_at', { ascending: false }),
    summariseCollections(db, [found.id]),
  ]);

  if (error) throw createError({ statusCode: 500, statusMessage: error.message });

  return {
    manager: found,
    isSelf,
    collection: summaries.get(found.id),
    cards: (rows || [])
      .filter((r: any) => r.card_definitions)
      .map((r: any) => ({
        id: r.id,
        level: r.level,
        copies: r.copies,
        acquiredAt: r.acquired_at,
        card: toCard(r.card_definitions),
      })),
  };
});
