import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { ROLES, slotForRole } from '~~/shared/roster';

/**
 * Put several cards in their slots at once — the "use my best five" plan.
 *
 * All or nothing. The Team screen used to save a plan one slot at a time, so a failure
 * halfway left a lineup that was neither the old five nor the new one. Here every card is
 * checked first (it exists, it is yours, it plays the lane), and then all of them are
 * written in one upsert, which PostgREST runs as a single INSERT ... ON CONFLICT: it lands
 * whole or not at all.
 *
 * Body: { slots: { TOP: collectionCardId, MID: collectionCardId, ... } }. Only the lanes
 * named change; this never empties a slot (that is /api/roster/slot with a null card).
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  await ensureProfile(db, manager);

  const body = await readBody<{ slots?: Record<string, string> }>(event);
  const wanted = Object.entries(body?.slots || {})
    .map(([role, id]) => [String(role).toUpperCase(), id] as const)
    .filter(([, id]) => Boolean(id));

  if (!wanted.length) throw createError({ statusCode: 400, statusMessage: 'No slots to change.' });
  for (const [role] of wanted) {
    if (!(ROLES as readonly string[]).includes(role)) {
      throw createError({ statusCode: 400, statusMessage: `${role} is not a role slot.` });
    }
  }
  if (new Set(wanted.map(([role]) => role)).size !== wanted.length
    || new Set(wanted.map(([, id]) => id)).size !== wanted.length) {
    throw createError({ statusCode: 400, statusMessage: 'Each slot takes one card, and each card one slot.' });
  }

  const { data: held, error: lookupError } = await db
    .from('collection_cards')
    .select('id, profile_id, card_definitions ( player_name, role )')
    .in('id', wanted.map(([, id]) => id));

  if (lookupError) throw createError({ statusCode: 500, statusMessage: lookupError.message });

  const byId = new Map((held || []).map((row: any) => [row.id, row]));
  for (const [role, id] of wanted) {
    const row = byId.get(id);
    if (!row || row.profile_id !== manager.id) {
      throw createError({ statusCode: 404, statusMessage: 'One of those cards is not in your collection.' });
    }
    const definition = row.card_definitions as any;
    const cardRole = slotForRole(definition?.role);
    if (cardRole !== role) {
      throw createError({
        statusCode: 400,
        statusMessage: `${definition?.player_name ?? 'That card'} plays ${cardRole}, not ${role}.`,
      });
    }
  }

  const now = new Date().toISOString();
  const { error: writeError } = await db
    .from('roster_slots')
    .upsert(
      wanted.map(([role, id]) => ({ profile_id: manager.id, role, collection_card_id: id, updated_at: now })),
      { onConflict: 'profile_id,role' },
    );

  if (writeError) throw createError({ statusCode: 500, statusMessage: writeError.message });

  return { changed: wanted.map(([role]) => role) };
});
