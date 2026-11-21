import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { stepAt, DRAFT_ORDER, DRAFT_LENGTH } from '~~/shared/draft';
import { loadActions, catchUp, draftPool, sideOf, botActsAt } from '~~/server/utils/duelRun';
import { compositionView } from '~~/server/utils/duel';
import { championRoles } from '~~/server/utils/championRoles';
import { rewardFor } from '~~/server/utils/rewards';

/**
 * The whole state of a duel room, as all three of its screens need it.
 *
 * This used to be the polled endpoint, read every 700 ms, and the clock was enforced as a
 * side effect of being read. It is now the *resync* endpoint: a client reads it once when it
 * enters the room, and again only if its realtime channel drops (docs/05 section 5.2). The
 * steady state is a push.
 *
 * That changes what belongs in the response. It now carries every instant the room's phases
 * turn on — `startsAt` for the lobby, `deadlineAt` for the action, `botActsAt` for the
 * agent, `watchStartAt` and `watchSpeed` for the shared match — so that a client which has
 * read this once can draw every screen and schedule every nudge without asking again.
 *
 * `serverNow` goes out with it so the client can measure its clock offset and render a
 * countdown that is right even on a device whose clock is wrong. The client never decides an
 * expiry, and with two people watching the same clock that stopped being a nicety: a draft
 * where each side's timer says something different is a draft where one of them has been
 * robbed.
 *
 * The champion pool is only sent when asked for. It is ~172 entries that never change during
 * a draft, and shipping it on every resync would be silly.
 *
 * The seed is never sent, and since migration 0015 a client cannot read it either: it
 * decides the agent's picks and the match, so knowing it is knowing the result.
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
  const theirSide = side === 'BLUE' ? 'RED' : side === 'RED' ? 'BLUE' : null;

  /**
   * Who the opponent is, or that there is not one.
   *
   * A bot duel has `opponent_id is null`, so there is no profile to read and nothing to
   * invent. The screen is told plainly that it is playing the agent rather than being handed
   * a name that looks like a person's — a draft against "Shadow Manager" that you cannot
   * find in discovery is worse than one that says what it is.
   */
  const otherId = duel.challenger_id === profileId ? duel.opponent_id : duel.challenger_id;
  const { data: other } = otherId
    ? await db.from('profiles').select('handle, display_name').eq('id', otherId).maybeSingle()
    : { data: null };

  /**
   * The pool, with where each champion is played. The roles are what lets the screen put an
   * off-pool champion in the lane it belongs to rather than the first open slot.
   */
  let pool: Array<{ key: string; name: string; roles: string[] }> | undefined;
  if (wantPool && duel.catalogue_version_id) {
    const [champions, roles] = await Promise.all([
      draftPool(db, duel.catalogue_version_id),
      championRoles(db, duel.catalogue_version_id),
    ]);
    pool = champions.map((c) => {
      const r = roles.get(c.key);
      return {
        ...c,
        roles: r ? [r.primary, ...[...r.flex].filter((s) => s !== r.primary)] : [],
      };
    });
  }

  // My own selection on the clock, so a reload mid-turn puts it back in my hand.
  const hover = duel.hover as any;
  const myHover = hover && side && hover.side === side && hover.turn === duel.turn && duel.status === 'DRAFTING'
    ? { championKey: hover.championKey, championName: hover.championName, slot: hover.slot ?? null }
    : null;

  return {
    id: duel.id,
    status: duel.status,
    source: duel.source ?? 'CHALLENGE',
    side,
    opponent: duel.bot_side
      ? 'The agent'
      : other?.display_name || other?.handle || 'Unknown manager',
    opponentHandle: other?.handle ?? null,
    // For a rematch. Null for the agent, which is nobody to challenge.
    opponentId: duel.bot_side ? null : otherId ?? null,
    isBot: Boolean(duel.bot_side),
    botSide: duel.bot_side ?? null,
    difficulty: duel.difficulty ?? null,
    iChallenged: duel.challenger_id === profileId,

    turn: duel.turn,
    length: DRAFT_LENGTH,
    order: DRAFT_ORDER,
    step,
    myTurn: Boolean(step && side && step.side === side),

    // Every instant the room's phases turn on, so one read is enough to draw any of them.
    startsAt: duel.starts_at ?? null,
    deadlineAt: duel.deadline_at,
    botActsAt: botActsAt(duel, duel.turn),
    watchStartAt: duel.watch_start_at ?? null,
    watchSpeed: duel.watch_speed ?? 60,
    serverNow: new Date().toISOString(),
    /**
     * The row's own write stamp. A realtime push carrying the same stamp changed nothing a
     * screen draws — a selection being saved, which deliberately does not bump it — and the
     * client skips the resync.
     */
    updatedAt: duel.updated_at ?? null,
    bonus: duel.bonus,
    myHover,

    actions,
    // Both lineups and both champion pools are open from the first ban. docs/05 section 2:
    // banning is only interesting when you know what you are banning against.
    blueLineup: duel.blue_lineup,
    redLineup: duel.red_lineup,

    /**
     * The composition as the engine will read it, for the panel beside the draft. Mine with
     * the modifier once it is complete; theirs as tags only — what they have picked is public,
     * the number the engine puts on it is not mine to be told.
     */
    composition: side && theirSide
      ? { mine: compositionView(actions, side, true), theirs: compositionView(actions, theirSide, false) }
      : null,

    pool,

    /**
     * The result travels with the room from the moment the draft ends, because the shared
     * watch is a rendering of it: both clients need the whole event log in hand before the
     * clock starts, or the first one to finish downloading it would be ahead of the other.
     *
     * That means the winner is readable before it has been watched. docs/05 section 6 made
     * that call already — spoiling your own replay is your business — and the alternative,
     * streaming the log in step with a clock, buys secrecy from a person who can open the
     * network tab anyway at the cost of the only thing that makes the watch shared.
     */
    result: duel.status === 'WATCHING' || duel.status === 'COMPLETE' ? duel.result : null,

    /**
     * What the match paid this manager, as the receipt the payout actually wrote
     * (docs/01 section 5). Read rather than recomputed: a result screen that worked the
     * numbers out for itself could disagree with the ledger, and the ledger is what the
     * Credits pill is counting.
     */
    rewards: duel.status === 'WATCHING' || duel.status === 'COMPLETE'
      ? await rewardFor(db, duel.id, profileId)
      : null,
  };
});
