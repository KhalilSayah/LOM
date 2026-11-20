import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseLeagueCode, roundRobin, seasonSchedule, matchDayCount,
  MAX_MANAGERS,
} from '../league.ts';

/**
 * The schedule, tested because it is generated once and then lived with.
 *
 * A fixture list is written in a single transaction at launch and never recomputed,
 * so a flaw in it is not a wrong pixel — it is a manager who plays the same opponent
 * three times and somebody else not at all, for a fortnight, with no way to fix it
 * short of deleting the season. Everything here is pure.
 *
 *   node --test --experimental-strip-types shared/test/*.test.ts
 */

const ids = (n: number) => Array.from({ length: n }, (_, i) => `m${i + 1}`);

// --- invite codes ------------------------------------------------------------

test('an invite code survives how people actually send it', () => {
  assert.equal(normaliseLeagueCode('H7K2M4'), 'H7K2M4');
  assert.equal(normaliseLeagueCode('h7k-2m4'), 'H7K2M4');
  assert.equal(normaliseLeagueCode('LOM-H7K2M4'), 'H7K2M4');
  // The lookalikes: O is a zero, I and L are ones.
  assert.equal(normaliseLeagueCode('h7k2mO'), 'H7K2M0');
  assert.equal(normaliseLeagueCode('I7K2M4'), '17K2M4');
  // A pasted link, which is what a group chat actually contains.
  assert.equal(normaliseLeagueCode('https://lom.app/join/H7K2M4'), 'H7K2M4');
  assert.equal(normaliseLeagueCode('https://lom.app/join/H7K2M4?from=chat'), 'H7K2M4');
});

test('a code that is not one comes back null', () => {
  assert.equal(normaliseLeagueCode(''), null);
  assert.equal(normaliseLeagueCode(null), null);
  assert.equal(normaliseLeagueCode('H7K2M'), null);      // five
  assert.equal(normaliseLeagueCode('H7K2M44'), null);    // seven
  assert.equal(normaliseLeagueCode('H7K2MU'), null);     // U is excluded, not mapped
});

// --- round robin -------------------------------------------------------------

test('everyone meets everyone exactly once in a round robin', () => {
  for (let n = 2; n <= MAX_MANAGERS; n++) {
    const rounds = roundRobin(ids(n));
    const met = new Map<string, number>();

    for (const day of rounds) {
      for (const p of day) {
        if (!p.red) continue;
        const key = [p.blue, p.red].sort().join('|');
        met.set(key, (met.get(key) ?? 0) + 1);
      }
    }

    const expected = (n * (n - 1)) / 2;
    assert.equal(met.size, expected, `${n} managers: ${met.size} pairs, expected ${expected}`);
    for (const [pair, times] of met) {
      assert.equal(times, 1, `${n} managers: ${pair} met ${times} times`);
    }
  }
});

test('nobody plays twice on the same day, and nobody is silently dropped', () => {
  for (let n = 2; n <= MAX_MANAGERS; n++) {
    for (const day of roundRobin(ids(n))) {
      const seen = new Set<string>();
      for (const p of day) {
        for (const side of [p.blue, p.red]) {
          if (!side) continue;
          assert.ok(!seen.has(side), `${n} managers: ${side} plays twice in one day`);
          seen.add(side);
        }
      }
      // Every manager appears each round — paired, or against a Ghost.
      assert.equal(seen.size, n, `${n} managers: only ${seen.size} played that day`);
    }
  }
});

test('an odd league gives the unpaired manager a Ghost, one each per cycle', () => {
  const rounds = roundRobin(ids(5));
  const ghosts = rounds.flat().filter((p) => p.red === null).map((p) => p.blue);
  assert.equal(ghosts.length, 5);
  assert.equal(new Set(ghosts).size, 5, 'the same manager got two Ghosts');
});

test('sides are shared out rather than handed to whoever joined first', () => {
  // Blue drafts first, so getting it every time is an advantage. Over a season
  // nobody should be more than one fixture away from an even split.
  for (let n = 2; n <= MAX_MANAGERS; n++) {
    const days = seasonSchedule(ids(n));
    const blue = new Map<string, number>();
    const red = new Map<string, number>();

    for (const day of days) {
      for (const p of day.pairings) {
        if (!p.red) continue;
        blue.set(p.blue, (blue.get(p.blue) ?? 0) + 1);
        red.set(p.red, (red.get(p.red) ?? 0) + 1);
      }
    }

    for (const id of ids(n)) {
      const diff = Math.abs((blue.get(id) ?? 0) - (red.get(id) ?? 0));
      assert.ok(diff <= 1, `${n} managers: ${id} has a side split off by ${diff}`);
    }
  }
});

// --- the season --------------------------------------------------------------

test('a season is about ten match days whatever the league size', () => {
  for (let n = 2; n <= MAX_MANAGERS; n++) {
    const played = matchDayCount(seasonSchedule(ids(n)));
    assert.ok(played >= 8 && played <= 12, `${n} managers produced ${played} match days`);
  }
});

test('rest days fall every fifth match day and never last', () => {
  const days = seasonSchedule(ids(6));
  assert.equal(days.filter((d) => d.rest).length, 1);
  assert.equal(days.find((d) => d.rest)?.dayIndex, 6);
  assert.equal(days[days.length - 1]!.rest, false);
});

test('day indexes are 1..n with no gaps', () => {
  const days = seasonSchedule(ids(4));
  days.forEach((d, i) => assert.equal(d.dayIndex, i + 1));
});

test('a short season is truncated, not stretched', () => {
  const days = seasonSchedule(ids(6), 4);
  assert.equal(days.length, 4);
  assert.equal(days[days.length - 1]!.rest, false);
});

test('a league outside the size band is refused', () => {
  assert.throws(() => seasonSchedule(ids(1)), /at least 2/);
  assert.throws(() => seasonSchedule(ids(7)), /at most 6/);
});
