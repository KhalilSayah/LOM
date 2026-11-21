import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { SLOTS, stepAt, takenChampions } from '~~/shared/draft';
import { loadActions, draftPool, sideOf } from '~~/server/utils/duelRun';

/**
 * "This is what I have in hand."
 *
 * The selection a player has made on their own turn but not locked, saved so that if the
 * clock beats them it locks their choice rather than one the agent makes up (catchUp in
 * server/utils/duelRun.ts). What the *opponent* sees is still the broadcast on the room
 * channel — this is not that, and it is never sent to the other side.
 *
 * It goes in `duels.hover`, the column migration 0006 made for a hover and 0007 stopped
 * writing. It deliberately does not bump `updated_at`: that stamp is how both clients tell a
 * real change from this one, and a selection is not a change either screen has to redraw.
 *
 * Best effort by design. A selection that fails to save leaves the old behaviour — the agent
 * picks — and is not worth an error on somebody's screen in the last seconds of their turn.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const id = getRouterParam(event, 'id');
  const body = await readBody<{ turn?: number; championKey?: string | null; slot?: string | null }>(event);

  const { data: duel } = await db
    .from('duels')
    .select('id, status, turn, blue_id, red_id, catalogue_version_id')
    .eq('id', id)
    .maybeSingle();
  if (!duel) throw createError({ statusCode: 404, statusMessage: 'No such duel.' });

  const side = sideOf(duel, profileId);
  if (!side) throw createError({ statusCode: 403, statusMessage: 'That duel is not yours.' });
  if (duel.status !== 'DRAFTING') return { ok: false };

  const step = stepAt(duel.turn);
  if (!step || step.side !== side || body?.turn !== duel.turn) return { ok: false };

  const championKey = String(body?.championKey ?? '').trim();
  if (!championKey) {
    await db.from('duels').update({ hover: null }).eq('id', duel.id).eq('turn', duel.turn);
    return { ok: true };
  }

  const [pool, actions] = await Promise.all([
    draftPool(db, duel.catalogue_version_id),
    loadActions(db, duel.id),
  ]);
  const champion = pool.find((c) => c.key === championKey);
  if (!champion || takenChampions(actions).has(championKey)) return { ok: false };

  const slot = step.kind === 'PICK' && body?.slot && (SLOTS as string[]).includes(body.slot) ? body.slot : null;

  // Conditional on the turn, so a save that arrives after the step moved on cannot pin a
  // choice to a step it was never made for.
  await db.from('duels').update({
    hover: {
      side,
      kind: step.kind,
      turn: duel.turn,
      championKey,
      championName: champion.name,
      slot,
      at: new Date().toISOString(),
    },
  }).eq('id', duel.id).eq('turn', duel.turn);

  return { ok: true };
});
