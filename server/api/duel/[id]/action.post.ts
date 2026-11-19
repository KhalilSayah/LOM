import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { illegalBecause, stepAt, type Slot } from '~~/shared/draft';
import { loadActions, catchUp, applyAction, draftPool, sideOf } from '~~/server/utils/duelRun';

/**
 * Lock one ban or pick.
 *
 * The clock is caught up *before* the action is judged, so a pick that arrives after the
 * timer ran out loses to the agent's move rather than overwriting it. That ordering is the
 * whole difference between a draft that is fair under lag and one that rewards a fast
 * connection.
 *
 * Legality is checked against the action log with the same function the client uses to grey
 * champions out, so the two can never disagree about what is available — and it is checked
 * here regardless, because the client's copy is a courtesy and this one is the rule.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const id = getRouterParam(event, 'id');
  const body = await readBody<{ championKey?: string; championName?: string; slot?: string | null }>(event);

  const { data: duel } = await db.from('duels').select('*').eq('id', id).maybeSingle();
  if (!duel) throw createError({ statusCode: 404, statusMessage: 'No such duel.' });

  const side = sideOf(duel, profileId);
  if (!side) throw createError({ statusCode: 403, statusMessage: 'That duel is not yours.' });

  let actions = await loadActions(db, duel.id);
  actions = await catchUp(db, duel, actions);

  if (duel.status !== 'DRAFTING') {
    throw createError({ statusCode: 409, statusMessage: 'This draft is over.' });
  }

  const step = stepAt(duel.turn);
  if (!step) throw createError({ statusCode: 409, statusMessage: 'This draft is over.' });

  const pool = await draftPool(db, duel.catalogue_version_id);
  const championKey = String(body?.championKey ?? '').trim();
  const slot = (body?.slot ? String(body.slot) : null) as Slot | null;

  const why = illegalBecause({
    turn: duel.turn,
    actions,
    side,
    kind: step.kind,
    championKey,
    slot,
    pool: new Set(pool.map((c) => c.key)),
  });
  if (why) throw createError({ statusCode: 409, statusMessage: why });

  const champion = pool.find((c) => c.key === championKey)!;

  try {
    actions = await applyAction(db, duel, actions, {
      side,
      kind: step.kind,
      championKey,
      championName: champion.name,
      slot: step.kind === 'PICK' ? slot : null,
    });
  } catch (e: any) {
    // The unique indexes caught a race the read could not: the agent or another tab got
    // there first. Reload and show them where the draft actually is.
    if (e?.code === '23505') {
      throw createError({ statusCode: 409, statusMessage: 'That action was already taken. Reloading.' });
    }
    throw createError({ statusCode: 500, statusMessage: e?.message || 'Could not lock that action.' });
  }

  return {
    turn: duel.turn,
    status: duel.status,
    actions,
    result: duel.status === 'COMPLETE' ? duel.result : null,
  };
});
