import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseLeagueCode, roundRobin, seasonSchedule, matchDayCount, seasonShape,
  fixtureWindow, kickOffText, dayWord, dateLabel, cleanTeamName,
  MAX_MANAGERS, FIXTURE_LOBBY_LEAD_SECONDS, FIXTURE_AUTOPLAY_AFTER_SECONDS,
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

test('every size plays everyone at least twice, once from each side', () => {
  // The season-length setting used to cut this off; now nothing can.
  for (let n = 2; n <= MAX_MANAGERS; n++) {
    const blueOf = new Map<string, number>();
    for (const day of seasonSchedule(ids(n))) {
      for (const p of day.pairings) {
        if (!p.red) continue;
        const key = `${p.blue}>${p.red}`;
        blueOf.set(key, (blueOf.get(key) ?? 0) + 1);
      }
    }
    for (const a of ids(n)) {
      for (const b of ids(n)) {
        if (a === b) continue;
        assert.ok((blueOf.get(`${a}>${b}`) ?? 0) >= 1, `${n} managers: ${a} never had blue against ${b}`);
      }
    }
  }
});

test('the Ghost does not always hand the manager first pick', () => {
  for (const n of [3, 5]) {
    const sides = new Map<string, { blue: number; red: number }>();
    for (const day of seasonSchedule(ids(n))) {
      for (const p of day.pairings) {
        if (p.red) continue;
        const s = sides.get(p.blue) ?? { blue: 0, red: 0 };
        // ghostSide RED means the manager is blue.
        if (p.ghostSide === 'BLUE') s.red += 1; else s.blue += 1;
        sides.set(p.blue, s);
      }
    }
    for (const [id, s] of sides) {
      assert.ok(Math.abs(s.blue - s.red) <= 1, `${n} managers: ${id} Ghost sides ${s.blue}/${s.red}`);
      assert.ok(s.red > 0, `${n} managers: ${id} always drafted first against the Ghost`);
    }
  }
});

test('the season shape is what the lobby promises', () => {
  const six = seasonShape(6);
  assert.equal(six.matchDays, 10);
  assert.equal(six.totalDays, 14);
  assert.equal(seasonShape(2).playoffDays, 1);
  for (let n = 2; n <= MAX_MANAGERS; n++) assert.ok(seasonShape(n).meetings >= 2);
});

test('a league outside the size band is refused', () => {
  assert.throws(() => seasonSchedule(ids(1)), /at least 2/);
  assert.throws(() => seasonSchedule(ids(7)), /at most 6/);
});

// --- a second season (docs/01 section 7 point 4) -----------------------------

test('a second season is the same calendar again, from day 1', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const first = seasonSchedule(ids);
  const second = seasonSchedule(ids);

  /**
   * The same members get the same calendar, counted from day 1 — the generator has no
   * memory of a season having been played, and should not grow one.
   *
   * This is the whole reason `league_fixtures.season` exists (migration 0014). A second
   * season collides with the first on every day index, so the two are told apart by the
   * season they belong to rather than by pushing the new one further down the calendar:
   * "day 1" has to mean the first evening of *this* season on everybody's screen.
   */
  assert.deepEqual(first, second);
  assert.equal(first[0]!.dayIndex, 1);
  assert.equal(second[0]!.dayIndex, 1);
});

test('a second season of a league that lost a manager is a smaller season, not a broken one', () => {
  // Somebody leaves between seasons. The calendar regenerates around who is left.
  const before = seasonSchedule(['a', 'b', 'c', 'd']);
  const after = seasonSchedule(['a', 'b', 'c']);

  assert.ok(matchDayCount(after) > 0);
  assert.notDeepEqual(before, after);
  // Three managers means a Ghost every round, and every one of them is somebody's fixture.
  assert.ok(after.filter((d) => !d.rest).every((d) => d.pairings.length > 0));
});

// --- kick-off ----------------------------------------------------------------

test('the lobby opens early, the draft is held to kick-off, and a day late is overdue', () => {
  const kick = Date.UTC(2026, 10, 21, 19, 30);
  const iso = new Date(kick).toISOString();
  assert.equal(fixtureWindow(iso, kick - FIXTURE_LOBBY_LEAD_SECONDS * 1000 - 1000).open, false);
  const lobby = fixtureWindow(iso, kick - 60_000);
  assert.equal(lobby.open, true);
  assert.equal(lobby.started, false);
  assert.equal(fixtureWindow(iso, kick + 1000).started, true);
  assert.equal(fixtureWindow(iso, kick + FIXTURE_AUTOPLAY_AFTER_SECONDS * 1000 - 1).overdue, false);
  assert.equal(fixtureWindow(iso, kick + FIXTURE_AUTOPLAY_AFTER_SECONDS * 1000).overdue, true);
});

test('a kick-off reads Today / Tomorrow on a 24-hour clock, never "tonight"', () => {
  const now = Date.UTC(2026, 10, 21, 10, 0);
  const noon = kickOffText(new Date(Date.UTC(2026, 10, 21, 11, 9)).toISOString(), { now, viewerTz: 'Europe/Paris', leagueTz: 'Europe/Paris' });
  assert.equal(noon.text, 'Today 12:09');
  assert.equal(noon.league, '');
  const tomorrow = kickOffText(new Date(Date.UTC(2026, 10, 22, 19, 30)).toISOString(), { now, viewerTz: 'Europe/Paris' });
  assert.equal(tomorrow.text, 'Tomorrow 20:30');
});

test('a viewer in another zone is shown the league clock too', () => {
  const now = Date.UTC(2026, 10, 21, 10, 0);
  const t = kickOffText(new Date(Date.UTC(2026, 10, 21, 19, 30)).toISOString(), {
    now, viewerTz: 'America/Montreal', leagueTz: 'Europe/Paris',
  });
  assert.equal(t.text, 'Today 14:30');
  assert.equal(t.league, '20:30 Paris time');
});

test('dates read like dates', () => {
  const now = Date.UTC(2026, 10, 21, 10, 0);
  assert.equal(dateLabel('2026-11-21', now), 'Sat 21 Nov');
  assert.equal(dayWord(Date.UTC(2026, 10, 24, 19), now, 'UTC'), 'Tuesday');
});

test('team names are tidied', () => {
  assert.equal(cleanTeamName('  T1   Fanclub '), 'T1 Fanclub');
  assert.equal(cleanTeamName('   '), null);
  assert.equal(cleanTeamName('x'.repeat(40))!.length, 24);
});
