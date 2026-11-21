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
  const body = await readBody<{ championKey?: string; championName?: string; slot?: string | null; turn?: number }>(event);

  const { data: duel } = await db.from('duels').select('*').eq('id', id).maybeSingle();
  if (!duel) throw createError({ statusCode: 404, statusMessage: 'No such duel.' });

  const side = sideOf(duel, profileId);
  if (!side) throw createError({ statusCode: 403, statusMessage: 'That duel is not yours.' });

  let actions = await loadActions(db, duel.id);
  actions = await catchUp(db, duel, actions);

  if (duel.status !== 'DRAFTING') {
    throw createError({ statusCode: 409, statusMessage: 'This draft is over.' });
  }

  // The lobby is still up. Nothing can go wrong if an action lands early — the clock already
  // accounts for the lobby — but a first ban locked before the other side has seen the room
  // open is a worse first impression of a duel than a brief refusal.
  if (duel.starts_at && Date.now() < new Date(duel.starts_at).getTime()) {
    throw createError({ statusCode: 409, statusMessage: 'The draft has not opened yet.' });
  }

  const step = stepAt(duel.turn);
  if (!step) throw createError({ statusCode: 409, statusMessage: 'This draft is over.' });

  /**
   * Which step this action was meant for.
   *
   * Without it the server judged an action against whatever step the draft had reached by
   * the time the request landed. A ban sent in the last second of step 4 that arrived after
   * the clock had locked step 4 and opened step 5 — also this side's, also a ban — was
   * quietly spent on step 5: the player lost their next ban to a click aimed at the last one.
   * The client says which step it was looking at, and a stale one is refused by name.
   */
  if (typeof body?.turn === 'number' && body.turn !== duel.turn) {
    const missed = stepAt(body.turn);
    throw createError({
      statusCode: 409,
      statusMessage: body.turn < duel.turn
        ? `Too late: the clock locked that ${missed?.kind === 'PICK' ? 'pick' : 'ban'} before yours arrived.`
        : 'Your screen was ahead of the draft. Showing where it is now.',
      data: { stale: true, turn: duel.turn },
    });
  }

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
      throw createError({
        statusCode: 409,
        statusMessage: 'The clock locked that step a moment before you did. Showing where the draft is now.',
        data: { stale: true },
      });
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
