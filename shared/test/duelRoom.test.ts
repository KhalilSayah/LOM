import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  phaseOf, watchClock, watchSettled, botThinkSeconds,
  LOBBY_SECONDS, RESULT_GRACE_SECONDS, BOT_THINK_MIN, BOT_THINK_MAX,
  type RoomTiming,
} from '../duelRoom.ts';

/**
 * The phase contract, tested because three things read it and they must agree.
 *
 * Both clients draw the screen from phaseOf() and the server closes the room from
 * watchSettled(). If those ever disagree the symptom is not a wrong pixel — it is one player
 * watching a match the other has already finished, or a room that never closes. Everything
 * here is pure and takes `now` as an argument precisely so it can be pinned like this.
 *
 *   node --test --experimental-strip-types shared/test/*.test.ts
 */

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const at = (seconds: number) => T0 + seconds * 1000;
const iso = (seconds: number) => new Date(at(seconds)).toISOString();

const drafting = (startsAtSecs: number): RoomTiming => ({
  status: 'DRAFTING',
  startsAt: iso(startsAtSecs),
  watchStartAt: null,
  watchSpeed: 60,
  gameLength: null,
});

/** A 30-minute match at 60×: 30 seconds of wall clock. */
const watching = (watchStartSecs: number): RoomTiming => ({
  status: 'WATCHING',
  startsAt: iso(0),
  watchStartAt: iso(watchStartSecs),
  watchSpeed: 60,
  gameLength: 1800,
});

test('the lobby holds until starts_at, then the draft opens', () => {
  const room = drafting(LOBBY_SECONDS);

  assert.equal(phaseOf(room, at(0)), 'LOBBY');
  assert.equal(phaseOf(room, at(LOBBY_SECONDS - 0.001)), 'LOBBY');
  assert.equal(phaseOf(room, at(LOBBY_SECONDS)), 'DRAFT');
  assert.equal(phaseOf(room, at(600)), 'DRAFT');
});

test('a draft with no starts_at is simply drafting', () => {
  // Duels created before migration 0007 have no lobby. They must not be stuck in one.
  const room: RoomTiming = { ...drafting(0), startsAt: null };
  assert.equal(phaseOf(room, at(0)), 'DRAFT');
});

test('the shared watch is the same match second for any two observers', () => {
  const room = watching(0);

  // Whoever asks, whenever they ask, the answer is a function of the one timestamp.
  assert.equal(watchClock(room, at(0)), 0);
  assert.equal(watchClock(room, at(1)), 60);
  assert.equal(watchClock(room, at(10)), 600);
  assert.equal(watchClock(room, at(15.5)), 930);
});

test('the watch clock never runs before the start or past the end', () => {
  const room = watching(3);

  // Before watch_start_at — the three-second lead after the last pick.
  assert.equal(watchClock(room, at(0)), 0);
  assert.equal(watchClock(room, at(2.9)), 0);

  // The match is 1800s at 60×, so it ends 30s of wall clock after it starts.
  assert.equal(watchClock(room, at(33)), 1800);
  assert.equal(watchClock(room, at(999)), 1800, 'clamped, not extrapolated');
});

test('WATCH becomes RESULT exactly when the match ends', () => {
  const room = watching(0);

  assert.equal(phaseOf(room, at(29.9)), 'WATCH');
  assert.equal(phaseOf(room, at(30)), 'RESULT');
  assert.equal(phaseOf(room, at(60)), 'RESULT');
});

test('the room is only settled after the result grace period', () => {
  const room = watching(0);

  // This is the pair that must not drift: the screen changes at 30s, the room closes at 50s.
  // Using the same instant for both is a hot loop — the server is nudged, finds nothing to
  // settle, and is nudged again immediately.
  assert.equal(watchSettled(room, at(30)), false, 'match over is not room closed');
  assert.equal(watchSettled(room, at(30 + RESULT_GRACE_SECONDS - 1)), false);
  assert.equal(watchSettled(room, at(30 + RESULT_GRACE_SECONDS)), true);
});

test('a finished match is not a room you are still needed in', () => {
  /**
   * The rule liveDuelFor, the nav badge and the Battle screen all now share.
   *
   * A duel stays WATCHING for twenty seconds after the match ends, so somebody who looked
   * away arrives at a live room rather than a history entry. Reading that status as "live"
   * is what trapped people: pressing Battle again from the result screen sent them back to
   * the result screen for as long as the grace lasted. Phase decides, not status.
   */
  const room = watching(0);
  const live = (now: number) => ['LOBBY', 'DRAFT', 'WATCH'].includes(phaseOf(room, now));

  assert.equal(live(at(10)), true, 'mid-match: still needed');
  assert.equal(live(at(29.9)), true);
  assert.equal(live(at(30)), false, 'match over: free to leave, though still WATCHING');
  assert.equal(live(at(40)), false, 'still WATCHING in the database, still free to leave');
  assert.equal(room.status, 'WATCHING', 'the status really has not changed');
});

test('a draft is a room you are needed in, lobby included', () => {
  const room = drafting(LOBBY_SECONDS);
  const live = (now: number) => ['LOBBY', 'DRAFT', 'WATCH'].includes(phaseOf(room, now));
  assert.equal(live(at(0)), true, 'the lobby counts — the other side is waiting');
  assert.equal(live(at(100)), true);
});

test('a watch that has not started cannot be settled', () => {
  const room: RoomTiming = { ...watching(0), watchStartAt: null };
  assert.equal(watchSettled(room, at(9999)), false);
  assert.equal(phaseOf(room, at(9999)), 'WATCH', 'no clock yet, so still waiting to watch');
});

test('watch speed scales the clock', () => {
  const slow: RoomTiming = { ...watching(0), watchSpeed: 1 };
  assert.equal(watchClock(slow, at(10)), 10);
  // At 1x a 30-minute match takes 30 minutes, so it is nowhere near over at 10s.
  assert.equal(phaseOf(slow, at(10)), 'WATCH');
});

test('settled and dead statuses report themselves', () => {
  const base = watching(0);
  assert.equal(phaseOf({ ...base, status: 'COMPLETE' }, at(0)), 'RESULT');
  assert.equal(phaseOf({ ...base, status: 'PENDING' }, at(0)), 'PENDING');
  assert.equal(phaseOf({ ...base, status: 'DECLINED' }, at(0)), 'DEAD');
  assert.equal(phaseOf({ ...base, status: 'CANCELLED' }, at(0)), 'DEAD');
});

test('the agent thinks for a human length of time, and the same one everywhere', () => {
  // Deterministic from (seed, turn) so the server and both clients agree on the moment
  // without anyone being told it.
  for (let turn = 0; turn < 20; turn++) {
    const a = botThinkSeconds('duel-abc', turn);
    const b = botThinkSeconds('duel-abc', turn);
    assert.equal(a, b, 'same inputs, same answer');
    assert.ok(a >= BOT_THINK_MIN && a < BOT_THINK_MAX, `${a}s is not a plausible pause`);
  }
});

test('the agent is not on a metronome', () => {
  // Ten identical pauses in a row read as a bug, which is the whole reason this is a range.
  const pauses = new Set(
    Array.from({ length: 20 }, (_, turn) => botThinkSeconds('duel-abc', turn)),
  );
  assert.ok(pauses.size > 15, `only ${pauses.size} distinct pauses across 20 actions`);
});

test('a different duel thinks differently', () => {
  assert.notEqual(botThinkSeconds('duel-abc', 0), botThinkSeconds('duel-xyz', 0));
});
