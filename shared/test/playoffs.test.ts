import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bracketFor, bracketState, seasonPlacings, seedOf, PLAYOFF_SIZE,
  type Bracket, type BracketResult,
} from '../playoffs.ts';
import { seasonPlacingCredits, seasonSettlement, SEASON_PLACING } from '../rewards.ts';

/**
 * The bracket, tested because it is the part of a season that cannot be replayed.
 *
 * A wrong table can be recomputed from the fixtures; a wrong final has already been
 * played. So every size docs/01 section 2 allows gets a case — including the degenerate
 * two- and three-manager leagues, which are the ones nobody will playtest and the ones
 * a four-slot bracket would quietly break.
 *
 *   node --test --experimental-strip-types shared/test/*.test.ts
 */

/** The final table, best first — what `standings()` hands over. */
const six = ['a', 'b', 'c', 'd', 'e', 'f'];

const won = (key: 'SF1' | 'SF2' | 'FINAL', memberId: string): BracketResult =>
  ({ key, winnerMemberId: memberId });

const match = (bracket: Bracket, key: string) => bracket.matches.find((m) => m.key === key)!;

// --- the shape ---------------------------------------------------------------

test('six managers make a top-four bracket: 1v4 and 2v3, then the final', () => {
  const bracket = bracketFor(six);

  assert.deepEqual(bracket.seeds, ['a', 'b', 'c', 'd']);
  assert.deepEqual(bracket.missed, ['e', 'f']);
  assert.equal(bracket.seeds.length, PLAYOFF_SIZE);

  assert.deepEqual(
    bracket.matches.map((m) => [m.key, m.stage, m.blueSeed, m.redSeed]),
    [
      ['SF1', 'SEMI', 1, 4],
      ['SF2', 'SEMI', 2, 3],
      ['FINAL', 'GRAND_FINAL', null, null],
    ],
  );

  // The final's sides arrive from the semis rather than from the table.
  assert.equal(match(bracket, 'FINAL').blueFrom, 'SF1');
  assert.equal(match(bracket, 'FINAL').redFrom, 'SF2');
});

test('four managers are all four seeds and nobody misses the cut', () => {
  const bracket = bracketFor(['a', 'b', 'c', 'd']);
  assert.deepEqual(bracket.missed, []);
  assert.equal(bracket.matches.length, 3);
});

test('three managers: the top seed byes to the final and 2 plays 3', () => {
  const bracket = bracketFor(['a', 'b', 'c']);

  assert.deepEqual(bracket.seeds, ['a', 'b', 'c']);
  assert.deepEqual(bracket.missed, []);
  assert.equal(bracket.matches.length, 2);

  assert.deepEqual(
    [match(bracket, 'SF1').blueSeed, match(bracket, 'SF1').redSeed],
    [2, 3],
  );

  // The bye is in the final before the semi is played, so its side is already known.
  const final = match(bracket, 'FINAL');
  assert.equal(final.blueSeed, 1);
  assert.equal(final.redFrom, 'SF1');

  assert.equal(bracketState(bracket, []).sides.FINAL.blue, 'a');
  assert.equal(bracketState(bracket, []).sides.FINAL.red, null);
});

test('two managers: no semis, the final is 1 v 2', () => {
  const bracket = bracketFor(['a', 'b']);
  assert.equal(bracket.matches.length, 1);
  assert.deepEqual(bracket.matches.map((m) => m.stage), ['GRAND_FINAL']);

  const sides = bracketState(bracket, []).sides;
  assert.deepEqual([sides.FINAL.blue, sides.FINAL.red], ['a', 'b']);
});

test('a league of one is not a bracket', () => {
  assert.throws(() => bracketFor(['a']), /at least two/);
  assert.throws(() => bracketFor([]), /at least two/);
});

test('a duplicated member id is seeded once', () => {
  const bracket = bracketFor(['a', 'a', 'b', 'c']);
  assert.deepEqual(bracket.seeds, ['a', 'b', 'c']);
});

// --- the higher seed drafts first --------------------------------------------

test('the higher seed takes blue in the semis', () => {
  const bracket = bracketFor(six);
  const sides = bracketState(bracket, []).sides;

  assert.deepEqual([sides.SF1.blue, sides.SF1.red], ['a', 'd']);
  assert.deepEqual([sides.SF2.blue, sides.SF2.red], ['b', 'c']);
});

test('the better-seeded finalist takes blue, whichever semi they came out of', () => {
  const bracket = bracketFor(six);

  // The fourth seed beats the first; the second beats the third. 2 is the better seed,
  // so 2 drafts first even though it came out of SF2.
  const state = bracketState(bracket, [won('SF1', 'd'), won('SF2', 'b')]);
  assert.deepEqual([state.sides.FINAL.blue, state.sides.FINAL.red], ['b', 'd']);

  // Seeding held: 1 out of SF1 and 2 out of SF2 leaves the order alone.
  const held = bracketState(bracket, [won('SF1', 'a'), won('SF2', 'b')]);
  assert.deepEqual([held.sides.FINAL.blue, held.sides.FINAL.red], ['a', 'b']);
});

test('one semi decided leaves the final half-known and undecided', () => {
  const bracket = bracketFor(six);
  const state = bracketState(bracket, [won('SF1', 'a')]);

  assert.equal(state.sides.FINAL.blue, 'a');
  assert.equal(state.sides.FINAL.red, null);
  assert.equal(state.decided, false);
  assert.equal(state.championMemberId, null);
  assert.deepEqual(seasonPlacings(bracket, state), []);
});

// --- the champion ------------------------------------------------------------

test('a decided final names a champion and a runner-up', () => {
  const bracket = bracketFor(six);
  const state = bracketState(bracket, [won('SF1', 'a'), won('SF2', 'c'), won('FINAL', 'c')]);

  assert.equal(state.decided, true);
  assert.equal(state.championMemberId, 'c');
  assert.equal(state.runnerUpMemberId, 'a');
  // Beaten semi-finalists, better seed first: 2 lost to 3, 4 lost to 1.
  assert.deepEqual(state.semiLosers, ['b', 'd']);
});

test('the state is the same however many times the results are applied', () => {
  const bracket = bracketFor(six);
  const results = [won('SF1', 'a'), won('SF2', 'b'), won('FINAL', 'b')];

  assert.deepEqual(
    bracketState(bracket, results),
    bracketState(bracket, [...results, ...results]),
  );
});

test('seedOf knows the table order, and that a non-seed has no seed', () => {
  const bracket = bracketFor(six);
  assert.equal(seedOf(bracket, 'a'), 1);
  assert.equal(seedOf(bracket, 'd'), 4);
  assert.equal(seedOf(bracket, 'e'), Infinity);
  assert.equal(seedOf(bracket, null), Infinity);
});

// --- the placings ------------------------------------------------------------

test('six managers get six placings, in the order the bracket decided', () => {
  const bracket = bracketFor(six);
  const state = bracketState(bracket, [won('SF1', 'd'), won('SF2', 'b'), won('FINAL', 'd')]);
  const placings = seasonPlacings(bracket, state);

  assert.deepEqual(placings, [
    { memberId: 'd', placing: 1 },  // the fourth seed ran the table
    { memberId: 'b', placing: 2 },
    { memberId: 'a', placing: 3 },  // lost SF1, better seed of the two losers
    { memberId: 'c', placing: 4 },
    { memberId: 'e', placing: 5 },  // missed the cut, in table order
    { memberId: 'f', placing: 6 },
  ]);
});

test('every member of the league is placed exactly once', () => {
  const bracket = bracketFor(six);
  const state = bracketState(bracket, [won('SF1', 'a'), won('SF2', 'c'), won('FINAL', 'a')]);
  const placings = seasonPlacings(bracket, state);

  assert.deepEqual([...placings].map((p) => p.memberId).sort(), [...six].sort());
  assert.deepEqual(placings.map((p) => p.placing), [1, 2, 3, 4, 5, 6]);
});

test('a three-manager bye that loses the final is second, and the semi loser is third', () => {
  const bracket = bracketFor(['a', 'b', 'c']);
  const state = bracketState(bracket, [won('SF1', 'b'), won('FINAL', 'b')]);

  assert.equal(state.championMemberId, 'b');
  assert.equal(state.runnerUpMemberId, 'a');
  assert.deepEqual(state.semiLosers, ['c']);

  assert.deepEqual(seasonPlacings(bracket, state), [
    { memberId: 'b', placing: 1 },
    { memberId: 'a', placing: 2 },
    { memberId: 'c', placing: 3 },
  ]);
});

test('a two-manager league places both', () => {
  const bracket = bracketFor(['a', 'b']);
  const state = bracketState(bracket, [won('FINAL', 'b')]);

  assert.deepEqual(seasonPlacings(bracket, state), [
    { memberId: 'b', placing: 1 },
    { memberId: 'a', placing: 2 },
  ]);
});

// --- what a placing pays (docs/01 section 5) ---------------------------------

test('the placings row of the reward table', () => {
  assert.equal(seasonPlacingCredits(1), 1500);
  assert.equal(seasonPlacingCredits(2), 900);
  assert.equal(seasonPlacingCredits(3), 500);
  assert.equal(seasonPlacingCredits(4), 500);
  assert.equal(seasonPlacingCredits(5), 250);
  assert.equal(seasonPlacingCredits(6), 250);

  assert.equal(SEASON_PLACING.semiFinal, seasonPlacingCredits(3));
});

test('a whole season pays every manager something', () => {
  const bracket = bracketFor(six);
  const state = bracketState(bracket, [won('SF1', 'a'), won('SF2', 'b'), won('FINAL', 'a')]);

  const paid = seasonPlacings(bracket, state).map((p) => seasonPlacingCredits(p.placing));
  assert.deepEqual(paid, [1500, 900, 500, 500, 250, 250]);
  assert.ok(paid.every((n) => n > 0));
});

// --- settling a season exactly once -----------------------------------------

/**
 * A fake ledger with the same unique constraint the real one has: one row per manager per
 * season. The point of these cases is the property, not the plumbing — settle a season
 * twice, or four times, and every manager is paid once.
 *
 * The race the index guards (two callers both reading an empty ledger) cannot be reproduced
 * here, because it is not a rule — it is a race, and it is settled in Postgres by the
 * unique index on `(league_id, season, profile_id)` that migration 0013 adds.
 * server/utils/seasonRewards.ts writes its claim row before it moves a single Credit for
 * exactly that reason.
 */
function ledger() {
  const rows = new Map<string, number>();
  return {
    settled: () => [...rows.keys()],
    pay(owed: { memberId: string; credits: number }[]) {
      for (const row of owed) {
        if (rows.has(row.memberId)) throw new Error(`paid ${row.memberId} twice`);
        rows.set(row.memberId, row.credits);
      }
    },
    total: () => [...rows.values()].reduce((n, c) => n + c, 0),
    of: (memberId: string) => rows.get(memberId) ?? 0,
  };
}

const finishedSeason = () => {
  const bracket = bracketFor(six);
  const state = bracketState(bracket, [won('SF1', 'a'), won('SF2', 'c'), won('FINAL', 'c')]);
  return seasonPlacings(bracket, state);
};

test('settling a season pays each placing once', () => {
  const placings = finishedSeason();
  const book = ledger();

  book.pay(seasonSettlement(placings, book.settled()));

  assert.equal(book.of('c'), 1500);  // champion
  assert.equal(book.of('a'), 900);   // lost the final
  assert.equal(book.of('b'), 500);   // lost a semi
  assert.equal(book.of('d'), 500);
  assert.equal(book.of('e'), 250);
  assert.equal(book.of('f'), 250);
  assert.equal(book.total(), 1500 + 900 + 500 + 500 + 250 + 250);
});

test('a season that settles twice pays once', () => {
  const placings = finishedSeason();
  const book = ledger();

  book.pay(seasonSettlement(placings, book.settled()));
  const after = book.total();

  // The second settle — the owner pressing the repair button, or the other manager's
  // client finishing the same grand final a moment later.
  const second = seasonSettlement(placings, book.settled());
  assert.deepEqual(second, []);

  book.pay(second);
  assert.equal(book.total(), after);
});

test('settling four times still pays once', () => {
  const placings = finishedSeason();
  const book = ledger();

  for (let n = 0; n < 4; n++) book.pay(seasonSettlement(placings, book.settled()));
  assert.equal(book.total(), 3900);
});

test('a settle interrupted halfway finishes the rest and repeats none of it', () => {
  const placings = finishedSeason();
  const book = ledger();

  // A crash after two managers were written: the claim rows exist, the rest do not.
  const owed = seasonSettlement(placings, []);
  book.pay(owed.slice(0, 2));

  const rest = seasonSettlement(placings, book.settled());
  assert.deepEqual(rest.map((r) => r.memberId), ['b', 'd', 'e', 'f']);

  book.pay(rest);
  assert.equal(book.total(), 3900);
});

test('an undecided bracket owes nothing at all', () => {
  const bracket = bracketFor(six);
  const half = bracketState(bracket, [won('SF1', 'a')]);

  assert.deepEqual(seasonPlacings(bracket, half), []);
  assert.deepEqual(seasonSettlement(seasonPlacings(bracket, half), []), []);
});

test('a member listed twice is owed once', () => {
  const owed = seasonSettlement(
    [{ memberId: 'a', placing: 1 }, { memberId: 'a', placing: 4 }],
    [],
  );
  assert.deepEqual(owed.map((o) => [o.memberId, o.credits]), [['a', 1500]]);
});

test('the receipt says what the placing was, in words', () => {
  const owed = seasonSettlement(finishedSeason(), []);
  assert.deepEqual(
    owed.slice(0, 4).map((o) => o.label),
    ['Champion', 'Runner-up', 'Third place', 'Fourth place'],
  );
  assert.equal(owed[4]!.label, 'Finished 5th');
});
