import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { stepAt, DRAFT_ORDER, DRAFT_LENGTH } from '~~/shared/draft';
import { loadActions, catchUp, draftPool, sideOf } from '~~/server/utils/duelRun';

/**
 * The whole state of a duel, as the draft screen needs it.
 *
 * This is the polled endpoint, so it is also where the clock is enforced: every read brings
 * the duel up to date first, which means an expired turn is resolved by whoever looks next
 * rather than by a background job. A draft that both players abandoned finishes the moment
 * either of them opens it again.
 *
 * `serverNow` goes out with every response so the client can measure its own clock offset
 * and render a countdown that is right even on a device whose clock is wrong. The client
 * never decides an expiry — docs/05 section 3.3.
 *
 * The champion pool is only sent when asked for. It is 172 entries that never change during
 * a draft, and shipping it once a second is the difference between a small poll and a silly
 * one.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const id = getRouterParam(event, 'id');
  const wantPool = getQuery(event).pool === '1';

  const { data: duel } = await db
    .from('duels')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (!duel) throw createError({ statusCode: 404, statusMessage: 'No such duel.' });
  if (duel.challenger_id !== profileId && duel.opponent_id !== profileId) {
    throw createError({ statusCode: 403, statusMessage: 'That duel is not yours.' });
  }

  let actions = await loadActions(db, duel.id);
  actions = await catchUp(db, duel, actions);

  const side = sideOf(duel, profileId);
  const step = duel.status === 'DRAFTING' ? stepAt(duel.turn) : null;

  const otherId = duel.challenger_id === profileId ? duel.opponent_id : duel.challenger_id;
  const { data: other } = await db
    .from('profiles').select('handle, display_name').eq('id', otherId).maybeSingle();

  return {
    id: duel.id,
    status: duel.status,
    side,
    opponent: other?.display_name || other?.handle || 'Unknown manager',
    iChallenged: duel.challenger_id === profileId,

    turn: duel.turn,
    length: DRAFT_LENGTH,
    order: DRAFT_ORDER,
    step,
    myTurn: Boolean(step && side && step.side === side),

    deadlineAt: duel.deadline_at,
    serverNow: new Date().toISOString(),
    bonus: duel.bonus,

    actions,
    // Only while it still belongs to the turn on the clock. A hover left over from the
    // previous action would show the opponent considering something they already locked.
    hover: duel.hover && duel.hover.turn === duel.turn ? duel.hover : null,
    // Both lineups and both champion pools are open from the first ban. docs/05 section 2:
    // banning is only interesting when you know what you are banning against.
    blueLineup: duel.blue_lineup,
    redLineup: duel.red_lineup,

    pool: wantPool && duel.catalogue_version_id
      ? await draftPool(db, duel.catalogue_version_id)
      : undefined,

    result: duel.status === 'COMPLETE' ? duel.result : null,
  };
});
