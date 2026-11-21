import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPayout, MATCH_REWARDS, GHOST_SHARE, isSGrade } from '../rewards.ts';

/**
 * What a match pays, tested against the table in docs/01 section 5.
 *
 * These are the numbers that decide how fast a collection grows, so every row of that
 * table gets a case where it is the only thing being paid — a reward that is only ever
 * tested inside a total is a reward nobody has checked.
 *
 *   node --test --experimental-strip-types shared/test/*.test.ts
 */

const five = (grades: (string | null)[] = [null, null, null, null, null]) =>
  grades.map((grade, i) => ({ cardKey: `card-${i}`, name: `Player ${i}`, grade }));

test('playing pays the appearance fee and nothing else', () => {
  const payout = matchPayout({ won: false, ghost: false, starters: five() });
  assert.equal(payout.credits, MATCH_REWARDS.play);
  assert.equal(payout.lines.length, 1);
  assert.equal(payout.cardXp.length, 5);
  for (const award of payout.cardXp) assert.equal(award.xp, MATCH_REWARDS.xp.play);
});

test('a win adds the win money on top of the appearance fee', () => {
  const payout = matchPayout({ won: true, ghost: false, starters: five() });
  assert.equal(payout.credits, MATCH_REWARDS.play + MATCH_REWARDS.win);
  for (const award of payout.cardXp) {
    assert.equal(award.xp, MATCH_REWARDS.xp.play + MATCH_REWARDS.xp.win);
  }
});

test('an S-grade pays its own Credits and its own XP, to that card only', () => {
  const payout = matchPayout({
    won: false,
    ghost: false,
    starters: five(['S', null, null, null, null]),
  });

  assert.equal(payout.credits, MATCH_REWARDS.play + MATCH_REWARDS.sGrade);
  assert.equal(payout.cardXp[0]!.xp, MATCH_REWARDS.xp.play + MATCH_REWARDS.xp.sGrade);
  assert.equal(payout.cardXp[1]!.xp, MATCH_REWARDS.xp.play);
});

test('S+ counts as an S-grade', () => {
  assert.ok(isSGrade('S+'));
  assert.ok(isSGrade('S'));
  assert.ok(!isSGrade('A'));

  const plus = matchPayout({ won: false, ghost: false, starters: five(['S+', null, null, null, null]) });
  assert.equal(plus.credits, MATCH_REWARDS.play + MATCH_REWARDS.sGrade);
});

test('five S-grades pay five times, because the award is per card', () => {
  const payout = matchPayout({ won: false, ghost: false, starters: five(['S', 'S', 'S', 'S+', 'S']) });
  assert.equal(payout.credits, MATCH_REWARDS.play + MATCH_REWARDS.sGrade * 5);
});

test('the first win of the season pays once, on top of the win', () => {
  const payout = matchPayout({
    won: true, ghost: false, firstWinOfSeason: true, starters: five(),
  });
  assert.equal(
    payout.credits,
    MATCH_REWARDS.play + MATCH_REWARDS.win + MATCH_REWARDS.firstWin,
  );
  assert.ok(payout.lines.some((l) => l.label.includes('First win')));
});

test('a loss cannot be the first win of the season', () => {
  const payout = matchPayout({ won: false, ghost: false, firstWinOfSeason: true, starters: five() });
  assert.equal(payout.credits, MATCH_REWARDS.play);
});

test('a Ghost pays half of everything, Credits and XP (docs/01 section 6)', () => {
  const payout = matchPayout({ won: true, ghost: true, starters: five(['S', null, null, null, null]) });

  assert.equal(
    payout.credits,
    Math.round(MATCH_REWARDS.play * GHOST_SHARE)
    + Math.round(MATCH_REWARDS.win * GHOST_SHARE)
    + Math.round(MATCH_REWARDS.sGrade * GHOST_SHARE),
  );
  assert.equal(
    payout.cardXp[1]!.xp,
    Math.round(MATCH_REWARDS.xp.play * GHOST_SHARE) + Math.round(MATCH_REWARDS.xp.win * GHOST_SHARE),
  );
});

test('a Ghost never pays the first win of the season', () => {
  const payout = matchPayout({ won: true, ghost: true, firstWinOfSeason: true, starters: five() });
  const halved = Math.round(MATCH_REWARDS.play * GHOST_SHARE) + Math.round(MATCH_REWARDS.win * GHOST_SHARE);
  assert.equal(payout.credits, halved);
});

test('past the Ghost allowance the XP still lands and the Credits do not', () => {
  const payout = matchPayout({
    won: true, ghost: true, creditsAllowed: false, starters: five(['S', null, null, null, null]),
  });

  assert.equal(payout.credits, 0);
  assert.ok(payout.creditsWithheld);
  // The receipt still explains itself, with the money zeroed rather than the lines removed.
  assert.ok(payout.lines.length > 0);
  for (const line of payout.lines) assert.equal(line.credits, 0);
  assert.ok(payout.xpTotal > 0);
});

test('an empty lineup pays the match and no card XP', () => {
  const payout = matchPayout({ won: true, ghost: false, starters: [] });
  assert.equal(payout.credits, MATCH_REWARDS.play + MATCH_REWARDS.win);
  assert.equal(payout.cardXp.length, 0);
  assert.equal(payout.xpTotal, 0);
});
