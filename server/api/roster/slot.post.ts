import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { ROLES, slotForRole } from '~~/shared/roster';

/**
 * Put a card in a slot, or empty the slot.
 *
 * One slot per request, saved as it is tapped. A roster screen with a Save button
 * invites exactly one bug — the person who edits, admires their work and leaves —
 * and there is nothing here worth batching: the write is a single row.
 *
 * Three things are checked, and all three have to be checked here rather than in a
 * policy: the card exists, it belongs to the person asking, and its role fits the
 * slot. The second is the one that matters — `collection_card_id` comes from the
 * request, so without it a manager could field somebody else's Faker.
 *
 * Several slots at once (the "use my best five" plan) go through /api/roster/lineup, which
 * makes the same checks and writes them in one statement.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  await ensureProfile(db, manager);

  const body = await readBody<{ role?: string; collectionCardId?: string | null }>(event);
  const role = String(body?.role ?? '').toUpperCase();

  if (!(ROLES as readonly string[]).includes(role)) {
    throw createError({ statusCode: 400, statusMessage: `${role || 'That'} is not a role slot.` });
  }

  // Clearing a slot is deleting the row: an empty slot is an absent row, never a row
  // holding a null card.
  if (!body?.collectionCardId) {
    const { error } = await db
      .from('roster_slots')
      .delete()
      .eq('profile_id', manager.id)
      .eq('role', role);

    if (error) throw createError({ statusCode: 500, statusMessage: error.message });
    return { role, card: null };
  }

  const { data: held, error: lookupError } = await db
    .from('collection_cards')
    .select('id, profile_id, card_definitions ( player_name, role )')
    .eq('id', body.collectionCardId)
    .maybeSingle();

  if (lookupError) throw createError({ statusCode: 500, statusMessage: lookupError.message });

  // Same answer for "no such card" and "not yours": whether a given id exists in
  // somebody else's collection is not this endpoint's to tell.
  if (!held || held.profile_id !== manager.id) {
    throw createError({ statusCode: 404, statusMessage: 'That card is not in your collection.' });
  }

  const definition = held.card_definitions as any;
  const cardRole = slotForRole(definition?.role);

  // A card only ever goes in its own lane. A card with no role is a MID card, because that
  // is how toCard() shows it and so the only slot the Team screen offers it in.
  if (cardRole !== role) {
    throw createError({
      statusCode: 400,
      statusMessage: `${definition?.player_name ?? 'That card'} plays ${cardRole}, not ${role}.`,
    });
  }

  // One statement. A card can only sit in its own role's slot, so the slot is the only
  // conflict there can be: the old delete-then-insert existed to move a card between slots,
  // which the rule above makes impossible, and it could leave the slot empty if the second
  // write failed.
  const { error: writeError } = await db
    .from('roster_slots')
    .upsert(
      {
        profile_id: manager.id,
        role,
        collection_card_id: held.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'profile_id,role' },
    );

  if (writeError) throw createError({ statusCode: 500, statusMessage: writeError.message });

  return { role, card: { id: held.id, playerName: definition?.player_name ?? null } };
});
