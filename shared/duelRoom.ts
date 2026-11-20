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
  /** Seconds of simulated match, from the result. Null until there is one. */
  gameLength: number | null;
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
