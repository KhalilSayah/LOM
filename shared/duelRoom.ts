/**
 * What phase a duel room is in, and when each phase turns into the next.
 *
 * Pure and shared, for the same reason shared/draft.ts is: the server decides, but both
 * clients have to draw the same screen at the same instant, and two copies of "has the
 * lobby finished yet" will disagree the first time one of them is edited.
 *
 * The one rule behind every number here: no phase boundary is ever decided by a client.
 * A client is given an instant — starts_at, deadline_at, watch_start_at — and all it does
 * is compare it to a clock it has corrected against the server's. That is what makes the
 * two screens the same screen.
 */

export type RoomPhase =
  /** A named challenge nobody has answered yet. No room, no clock. */
  | 'PENDING'
  /** Paired. Both players are being shown who they drew, and the draft has not opened. */
  | 'LOBBY'
  /** Bans and picks. */
  | 'DRAFT'
  /** The match, on one clock, both watching the same second of it. */
  | 'WATCH'
  /** The watch has run out. Result and box score. */
  | 'RESULT'
  /** Declined, withdrawn, or otherwise never happened. */
  | 'DEAD';

/**
 * How long "match found" is on screen before the first ban opens.
 *
 * Four seconds, and it is load time rather than theatre. A queue match has no accept step,
 * so the two clients arrive whenever their own navigation and subscription finish; without
 * a lobby the player whose phone took two seconds longer starts their first ban two seconds
 * down. The lobby is inside the first action's deadline, so it costs nobody any thinking
 * time — see duel_matchmake in migration 0007.
 */
export const LOBBY_SECONDS = 4;

/**
 * The gap between the draft locking its last pick and the match starting.
 *
 * Both clients have to be told the draft is over, fetch a result they have never seen, and
 * get a map on screen. Three seconds is enough for that on a phone, and it also gives the
 * last pick a moment to land rather than being wiped by a screen change.
 */
export const WATCH_LEAD_SECONDS = 3;

/**
 * How fast the shared watch runs. 60× puts a thirty-minute game in about thirty seconds.
 *
 * Stored on the duel row rather than read from here, so a duel always replays at the speed
 * it was watched at. This is the default a new duel gets.
 */
export const WATCH_SPEED = 60;

/**
 * How long the result stays on the shared clock before the room is settled.
 *
 * The watch ends, both players look at the box score, and the duel is only written off as
 * COMPLETE after this. It exists so that "the match finished" and "the room closed" are not
 * the same instant — a player who tabbed away for the last ten seconds still arrives to a
 * live room rather than a history entry.
 */
export const RESULT_GRACE_SECONDS = 20;

/**
 * How long the agent thinks before acting on a side it is playing on purpose.
 *
 * A bot that answers instantly is unpleasant in a way that is hard to name until you play
 * one: the draft stops feeling like a conversation and starts feeling like a form. It is
 * also indistinguishable from a bug, because a human pick and an instant pick do not look
 * alike. Two to six seconds reads as somebody deciding.
 *
 * It is a range and not a constant so that ten picks in a row do not arrive on a metronome.
 */
export const BOT_THINK_MIN = 2;
export const BOT_THINK_MAX = 6;

/**
 * How hard the agent tries, on a practice duel.
 *
 * Only practice has a choice. The agent standing in for somebody who walked away, and the
 * agent the queue offers after an empty search, both play NORMAL — the docs/05 section 4
 * "reasonable friend who is not paying full attention". Practice is where a person asks for
 * something else, and nothing played there counts anywhere, so it can be as soft or as sharp
 * as they like.
 */
export type Difficulty = 'EASY' | 'NORMAL' | 'HARD';
export const DIFFICULTIES: Difficulty[] = ['EASY', 'NORMAL', 'HARD'];
export const DIFFICULTY_LABEL: Record<Difficulty, string> = { EASY: 'Easy', NORMAL: 'Normal', HARD: 'Hard' };
export const asDifficulty = (v: unknown): Difficulty =>
  (DIFFICULTIES as string[]).includes(String(v).toUpperCase()) ? (String(v).toUpperCase() as Difficulty) : 'NORMAL';

/** Deterministic think time for one action, so every client agrees when the bot will move. */
export function botThinkSeconds(seed: string, turn: number): number {
  let h = 2166136261;
  const s = `${seed}:bot:${turn}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const span = BOT_THINK_MAX - BOT_THINK_MIN;
  return BOT_THINK_MIN + ((h >>> 0) % (span * 1000)) / 1000;
}

export interface RoomTiming {
  status: string;
  startsAt: string | null;
  watchStartAt: string | null;
  watchSpeed: number;
  /**
   * Seconds of simulated match until the last thing on screen happens. Null until there is
   * a result. Build it with matchEnd(result), never with `result.gameLength` alone.
   */
  gameLength: number | null;
}

/**
 * When a simulated match really ends, in match seconds.
 *
 * The engine nudges events that share a tick a second apart so the play-by-play keeps its
 * order, and in a busy ending (the Baron fight, the push, the nexus) that carries the last
 * events up to a minute past `gameLength`. A clock that stops at `gameLength` never shows the
 * nexus falling, and a screen that turns over at `gameLength` cuts away before it does. Every
 * clock and every phase boundary in a duel room is measured against this instead.
 *
 * Same rule as app/utils/matchEnd.ts, kept here as well because the server decides when a
 * room is over and cannot import from the app.
 */
export function matchEnd(result: any): number {
  if (!result) return 0;
  const events = Array.isArray(result.events) ? result.events : [];
  const last = events.length ? Number(events[events.length - 1]?.t ?? 0) : 0;
  return Math.max(Number(result.gameLength ?? 0), Number.isFinite(last) ? last : 0);
}

/** A duel row (snake_case, as the database has it) as phaseOf() wants to read it. */
export function timingOfRow(duel: {
  status: string;
  starts_at?: string | null;
  watch_start_at?: string | null;
  watch_speed?: number | null;
  result?: any;
}): RoomTiming {
  return {
    status: duel.status,
    startsAt: duel.starts_at ?? null,
    watchStartAt: duel.watch_start_at ?? null,
    watchSpeed: duel.watch_speed ?? WATCH_SPEED,
    gameLength: duel.result ? matchEnd(duel.result) : null,
  };
}

/**
 * The draft clock as a person should read it: the action's own thirty seconds, then the
 * side's bonus pool, as one countdown that never jumps.
 *
 * The server stakes the whole bonus pool the moment the thirty seconds run out and pushes
 * the deadline out by that much (server/utils/duelRun.ts). Rendered raw, that is a clock
 * that hits zero, sits there for the length of a round trip, and then leaps to sixty — which
 * reads as a bug, and to the person whose turn it is reads as "I have more time than I
 * thought" only after they have already panicked. So the bonus is predicted here from the
 * same numbers the server will use, and shown as what it is.
 */
export interface DraftClock {
  /** Seconds of the action's own timer left. 0 once it has run out. */
  main: number;
  /** Seconds of bonus time this side has left: the pool before it is touched, then what remains of it. */
  bonus: number;
  /** True once the action timer is spent and the side is thinking on bonus time. */
  inBonus: boolean;
  /** The one number to put on screen. */
  shown: number;
}

export function draftClock(input: {
  deadlineAt: string | null;
  /** duels.bonus: `{ BLUE, RED, staked: { side, amount } | null }`. */
  bonus: Record<string, any> | null | undefined;
  side: 'BLUE' | 'RED' | null | undefined;
  /** The agent never spends bonus time on a side it is playing on purpose. */
  botSide?: string | null;
  now: number;
}): DraftClock | null {
  if (!input.deadlineAt || !input.side) return null;
  const bonus = input.bonus || {};
  const staked = bonus.staked && bonus.staked.side === input.side ? Number(bonus.staked.amount) || 0 : 0;
  const pool = input.botSide === input.side ? 0 : staked || Number(bonus[input.side] ?? 0) || 0;
  // Once staked, deadline_at already has the pool in it; the action's own timer ended `staked` earlier.
  const base = new Date(input.deadlineAt).getTime() - staked * 1000;
  const main = Math.max(0, Math.ceil((base - input.now) / 1000));
  if (input.now < base || pool <= 0) {
    return { main, bonus: pool, inBonus: false, shown: main };
  }
  const left = Math.max(0, Math.ceil((base + pool * 1000 - input.now) / 1000));
  return { main: 0, bonus: left, inBonus: true, shown: left };
}

/**
 * Which phase a room is in, given the server's instants and a corrected clock.
 *
 * `now` is the caller's millisecond clock already corrected by its measured offset — on the
 * server that is simply Date.now(). Passing it in rather than reading the clock inside is
 * what makes this testable and what keeps the client honest: a client that wants to know the
 * phase has to have done its clock correction first.
 */
export function phaseOf(room: RoomTiming, now: number): RoomPhase {
  switch (room.status) {
    case 'PENDING':
      return 'PENDING';
    case 'DECLINED':
    case 'CANCELLED':
    case 'EXPIRED':
      return 'DEAD';
    case 'DRAFTING':
      if (room.startsAt && now < new Date(room.startsAt).getTime()) return 'LOBBY';
      return 'DRAFT';
    case 'WATCHING':
      return watchElapsed(room, now) === null ? 'WATCH' : 'RESULT';
    default:
      return 'RESULT';
  }
}

/**
 * How far into the match the shared clock is, in match seconds — or null once it is over.
 *
 * The null is the point: it is the single definition of "the match has finished", and both
 * the client's screen change and the server's decision to settle the room read it. A match
 * that is over on one of those and not the other is the bug this function exists to make
 * impossible.
 */
export function watchClock(room: RoomTiming, now: number): number {
  if (!room.watchStartAt) return 0;
  const elapsed = (now - new Date(room.watchStartAt).getTime()) / 1000;
  const matchSeconds = elapsed * (room.watchSpeed || WATCH_SPEED);
  if (matchSeconds < 0) return 0;
  return room.gameLength === null ? matchSeconds : Math.min(matchSeconds, room.gameLength);
}

/** Null while the match is still running; seconds past the end once it is not. */
function watchElapsed(room: RoomTiming, now: number): number | null {
  if (!room.watchStartAt || room.gameLength === null) return null;
  const wallLength = room.gameLength / (room.watchSpeed || WATCH_SPEED);
  const over = (now - new Date(room.watchStartAt).getTime()) / 1000 - wallLength;
  return over >= 0 ? over : null;
}

/** True once the room has been sitting on its result long enough to be written off. */
export function watchSettled(room: RoomTiming, now: number): boolean {
  const over = watchElapsed(room, now);
  return over !== null && over >= RESULT_GRACE_SECONDS;
}

/** Seconds until the shared watch begins. Negative once it has. */
export const secondsUntil = (at: string | null, now: number): number =>
  at ? (new Date(at).getTime() - now) / 1000 : 0;
