import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { loadActions, catchUp, sideOf, botActsAt } from '~~/server/utils/duelRun';

/**
 * "A clock in here has run out — go and look."
 *
 * This is what replaces polling, and it is the one piece of the rework that is not obvious.
 *
 * The old draft screen asked the server for the whole duel every 700 ms, and the clock was
 * enforced as a side effect of being asked: an expired turn was resolved by whoever happened
 * to read next. Take the polling away and that enforcement goes with it — the deadline
 * passes, nothing is listening on the server, and both players sit watching a timer at zero
 * on a turn that will never move.
 *
 * So the client keeps the one thing polling was actually buying. Instead of a request a
 * second it sets a single timer for the exact instant something is due — the deadline, or the
 * moment the agent is going to move — and sends one request then. Everything else arrives as
 * a realtime push. A whole draft costs about twenty of these rather than about five hundred
 * polls, and nothing about correctness depends on the client getting it right: a nudge that
 * never comes leaves the room exactly as stale as the old version left an unwatched draft,
 * and a nudge that comes early finds nothing expired and does nothing.
 *
 * It is unauthenticated as to *intent* on purpose. There is no payload and nothing to assert:
 * a participant asking for a room to be brought up to date can only ever produce the state
 * the clock already implies.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const id = getRouterParam(event, 'id');

  const { data: duel } = await db.from('duels').select('*').eq('id', id).maybeSingle();
  if (!duel) throw createError({ statusCode: 404, statusMessage: 'No such duel.' });
  if (duel.challenger_id !== profileId && duel.opponent_id !== profileId) {
    throw createError({ statusCode: 403, statusMessage: 'That duel is not yours.' });
  }

  const actions = await catchUp(db, duel, await loadActions(db, duel.id));

  /**
   * What came back is deliberately thin. Whatever catchUp changed has already been written,
   * and the write is what both clients are subscribed to — so the push is the answer and
   * this response only needs to tell the caller when to set its next timer.
   */
  return {
    turn: duel.turn,
    status: duel.status,
    deadlineAt: duel.deadline_at,
    // A staked bonus pool changes the clock without changing the turn; the screen needs it
    // to keep showing "bonus time" rather than a deadline that seems to have moved by itself.
    bonus: duel.bonus,
    botActsAt: botActsAt(duel, duel.turn),
    watchStartAt: duel.watch_start_at ?? null,
    locked: actions.length,
    serverNow: new Date().toISOString(),
    side: sideOf(duel, profileId),
  };
});
