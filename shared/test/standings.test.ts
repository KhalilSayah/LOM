import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  standings, formOf, headToHead, upsetIds, WIN_POINTS, type PlayedFixture, type ResultFixture,
} from '../standings.ts';

/**
 * The table, tested because it is the thing a league argues about.
 *
 * Every tiebreak in docs/01 section 3 gets a case where it is the *only* thing
 * separating two managers, because a tiebreak that is never reached in a test is a
 * tiebreak nobody has checked.
 *
 *   node --test --experimental-strip-types shared/test/*.test.ts
 */

const played = (
  blue: string, red: string, winner: string,
  { length = 1800, blueKills = 10, redKills = 10, stage = 'REGULAR' as const, status = 'FINAL' } = {},
): PlayedFixture => ({
  stage,
  status,
  blueMemberId: blue,
  redMemberId: red,
  winnerMemberId: winner,
  gameLength: length,
  blueKills,
  redKills,
});

const order = (rows: ReturnType<typeof standings>) => rows.map((r) => r.memberId);

test('a win is three points and a loss is none', () => {
  const rows = standings(['a', 'b'], [played('a', 'b', 'a')]);
  assert.equal(rows[0]!.memberId, 'a');
  assert.equal(rows[0]!.points, WIN_POINTS);
  assert.equal(rows[0]!.won, 1);
  assert.equal(rows[1]!.points, 0);
  assert.equal(rows[1]!.lost, 1);
  assert.equal(rows[1]!.played, 1);
});

test('everyone in the league is in the table, including managers who have not played', () => {
  const rows = standings(['a', 'b', 'c'], [played('a', 'b', 'a')]);
  assert.equal(rows.length, 3);
  assert.equal(rows.find((r) => r.memberId === 'c')!.played, 0);
});

test('Ghost fixtures are played but do not count', () => {
  const ghost: PlayedFixture = {
    stage: 'GHOST',
    status: 'FINAL',
    blueMemberId: 'a',
    redMemberId: null,
    winnerMemberId: 'a',
    gameLength: 1500,
    blueKills: 14,
    redKills: 3,
  };
  const rows = standings(['a', 'b'], [ghost]);
  assert.equal(rows.find((r) => r.memberId === 'a')!.played, 0);
  assert.equal(rows.find((r) => r.memberId === 'a')!.points, 0);
});

test('a fixture that is not final has no result to count', () => {
  const rows = standings(['a', 'b'], [played('a', 'b', 'a', { status: 'PLAYING' })]);
  assert.equal(rows[0]!.played, 0);
});

test('head-to-head separates two managers on the same points', () => {
  // a and b finish level on 3, c on 6, d on 0 — so the tied cluster is exactly
  // {a, b}, and the only thing in it is that a beat b.
  const rows = standings(['a', 'b', 'c', 'd'], [
    played('a', 'b', 'a'),
    played('b', 'd', 'b'),
    played('c', 'd', 'c'),
    played('c', 'a', 'c'),
  ]);
  const a = rows.find((r) => r.memberId === 'a')!;
  const b = rows.find((r) => r.memberId === 'b')!;
  assert.equal(a.points, b.points, 'the fixture set should leave a and b level on points');
  assert.ok(a.position < b.position, 'a beat b and should be above them');
  assert.equal(b.decidedBy, 'HEAD_TO_HEAD');
});

test('a three-way tie is resolved as a mini-table, not pair by pair', () => {
  // a beat b, b beat c, c beat a: a cycle. Everyone has one win over the cluster, so
  // head-to-head cannot separate them and the tiebreaks below it have to.
  const rows = standings(['a', 'b', 'c'], [
    played('a', 'b', 'a', { length: 1500 }),
    played('b', 'c', 'b', { length: 1800, blueKills: 15, redKills: 3 }),
    played('c', 'a', 'c', { length: 2100 }),
  ]);
  assert.equal(new Set(rows.map((r) => r.points)).size, 1, 'all three should be level');

  // Time: a won in 25 min and lost a 35 min game (+600); b and c are both on -300,
  // so a is clear on the clock and b passes c on kills.
  assert.deepEqual(order(rows), ['a', 'b', 'c']);
  assert.equal(rows[1]!.decidedBy, 'TIME');
  assert.equal(rows[2]!.decidedBy, 'KILLS');
});

test('a fast win beats a slow one when nothing else separates two managers', () => {
  const rows = standings(['a', 'b', 'x', 'y'], [
    played('a', 'x', 'a', { length: 1400 }),
    played('b', 'y', 'b', { length: 2400 }),
  ]);
  // a and b never met, so head-to-head is silent and time decides.
  assert.deepEqual(order(rows).slice(0, 2), ['a', 'b']);
  assert.equal(rows[1]!.decidedBy, 'TIME');
});

test('kills decide when the clock does not', () => {
  const rows = standings(['a', 'b', 'x', 'y'], [
    played('a', 'x', 'a', { length: 1800, blueKills: 22, redKills: 4 }),
    played('b', 'y', 'b', { length: 1800, blueKills: 9, redKills: 5 }),
  ]);
  assert.deepEqual(order(rows).slice(0, 2), ['a', 'b']);
  assert.equal(rows[1]!.decidedBy, 'KILLS');
});

test('the last resort is stable, and seeded by the league', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const first = order(standings(ids, [], 'league-1'));
  const again = order(standings([...ids].reverse(), [], 'league-1'));
  assert.deepEqual(first, again, 'the same league must always draw the same order');
  assert.equal(standings(ids, [], 'league-1')[1]!.decidedBy, 'COIN');

  // A different league is allowed — and expected — to break the tie differently.
  const other = order(standings(ids, [], 'league-2'));
  assert.equal(other.length, 4);
});

test('positions are 1..n with no gaps', () => {
  const rows = standings(['a', 'b', 'c'], [played('a', 'b', 'a')]);
  rows.forEach((r, i) => assert.equal(r.position, i + 1));
});

test('a result involving somebody who has left is not scored', () => {
  const rows = standings(['a'], [played('a', 'gone', 'gone')]);
  assert.equal(rows[0]!.played, 0);
});

// --- one manager's season ----------------------------------------------------

let day = 0;
const result = (blue: string | null, red: string | null, winnerSide: 'BLUE' | 'RED', stage = 'REGULAR'): ResultFixture => {
  day += 1;
  const at = new Date(Date.UTC(2026, 0, day)).toISOString();
  return {
    id: `f${day}`, stage, status: 'FINAL', blueMemberId: blue, redMemberId: red,
    winnerSide, winnerMemberId: winnerSide === 'BLUE' ? blue : red, playedAt: at, scheduledAt: at,
  };
};

test('form is the last five against managers, oldest first, Ghosts left out', () => {
  day = 0;
  const fx = [
    result('a', 'b', 'BLUE'), result('a', null, 'BLUE', 'GHOST'), result('c', 'a', 'BLUE'),
    result('a', 'b', 'RED'), result('a', 'c', 'BLUE'), result('b', 'a', 'RED'), result('a', 'c', 'BLUE'),
  ];
  assert.deepEqual(formOf('a', fx), ['L', 'L', 'W', 'W', 'W']);
  assert.deepEqual(headToHead('a', 'b', fx), { played: 3, won: 2, lost: 1 });
});

test('an upset is two wins of table beaten, or the lower seed winning a playoff', () => {
  day = 0;
  const fx = [
    result('a', 'c', 'BLUE'), result('a', 'd', 'BLUE'),
    result('a', 'c', 'RED'),           // c beats a, who was 6 points clear: an upset
    result('a', 'b', 'BLUE'),          // a beats b: expected
    result('a', 'b', 'RED', 'SEMI'),   // lower seed wins: an upset
  ];
  const up = upsetIds(fx);
  assert.deepEqual([...up].sort(), ['f3', 'f5']);
});
