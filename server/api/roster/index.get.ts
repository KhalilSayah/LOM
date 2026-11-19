import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { CARD_SELECT, toCard } from '~~/shared/cardShape';
import { ROLES } from '~~/shared/roster';

/**
 * The manager's standing five, and everything they could put in it.
 *
 * Both halves in one response on purpose. The picker has to open instantly — it is
 * the screen's main interaction — and the collection is already a single query the
 * client makes on its own screen, so fetching it here costs one round trip instead
 * of a loading state behind every slot.
 *
 * Empty slots come back as nulls rather than missing keys, so the client can render
 * five slots without knowing which ones exist.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  await ensureProfile(db, manager);

  const [{ data: slots, error: slotError }, { data: owned, error: ownedError }] = await Promise.all([
    db.from('roster_slots')
      .select('role, collection_card_id, updated_at')
      .eq('profile_id', manager.id),
    db.from('collection_cards')
      .select(`id, level, xp, copies, acquired_at, card_definitions ( ${CARD_SELECT} )`)
      .eq('profile_id', manager.id)
      .order('acquired_at', { ascending: false }),
  ]);

  const error = slotError || ownedError;
  if (error) throw createError({ statusCode: 500, statusMessage: error.message });

  const cards = (owned || [])
    .filter((row: any) => row.card_definitions)
    .map((row: any) => ({
      id: row.id,
      level: row.level,
      copies: row.copies,
      card: toCard(row.card_definitions),
    }));

  const byId = new Map(cards.map((c) => [c.id, c]));
  const filled: Record<string, any> = {};
  for (const role of ROLES) filled[role] = null;

  for (const slot of (slots || []) as any[]) {
    const held = byId.get(slot.collection_card_id);
    // A slot whose card is gone should not break the screen. It cannot happen while
    // nothing deletes collection rows, and the foreign key would cascade it away if
    // something did, but a roster that renders is worth more than one that is right.
    if (held) filled[slot.role] = { ...held, updatedAt: slot.updated_at };
  }

  return {
    roster: filled,
    owned: cards,
  };
});
