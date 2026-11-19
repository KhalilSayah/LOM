/**
 * The Monte Carlo harness (docs/04 section 9).
 *
 * These rows are the actual definition of "correctly tuned" — not a sanity check
 * after the fact, but the thing the constants are fitted to. docs/10 makes it a CI
 * gate: any change to BALANCE or to the engine has to leave every row green.
 *
 *   node packages/sim/balance.mjs
 *   node packages/sim/balance.mjs --sims 20000
 *
 * Tuning order when a row fails, from docs/04 section 9: k and sigma for the win-rate
 * rows, pressureRate and siege conversion for the game-length rows, skirmishRate and
 * the teamfight loss curves for kill counts. One constant at a time — the harness is
 * cheap and guessing is not.
 */

import { simulate } from './src/index.js';
import { makeTeam } from './fixtures/teams.mjs';

const args = process.argv.slice(2);
const sims = Number(args[args.indexOf('--sims') + 1]) || 4000;
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

/** One batch of matches, with the sides swapped every other game so no bias hides. */
function run(blueRating, redRating, opts = {}, count = sims) {
  const results = [];

  for (let i = 0; i < count; i++) {
    const swap = i % 2 === 1;
    const blue = makeTeam('blue', swap ? redRating : blueRating, swap ? opts.red : opts.blue);
    const red = makeTeam('red', swap ? blueRating : redRating, swap ? opts.blue : opts.red);

    const result = simulate({ seed: `balance-${i}`, blue, red });
    const favouredWon = swap
      ? result.winner === 'RED'
      : result.winner === 'BLUE';

    results.push({ ...result, favouredWon });
  }

  return results;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const stddev = (xs) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};
const killsOf = (r) => r.boxScore.reduce((n, row) => n + row.kills, 0);

const rows = [];
const check = (name, value, low, high, unit = '') => {
  rows.push({ name, value, low, high, unit, pass: value >= low && value <= high });
};

const pct = (xs, f) => (100 * xs.filter(f).length) / (xs.length || 1);

// --- win rate by rating edge -------------------------------------------------
const equal = run(70, 70);
check('Win rate, equal squads', pct(equal, (r) => r.favouredWon), 49, 51, '%');

if (!only) {
  check('Win rate, +5 effRating', pct(run(75, 70), (r) => r.favouredWon), 56, 59, '%');
  check('Win rate, +10 effRating', pct(run(80, 70), (r) => r.favouredWon), 62, 66, '%');
  check('Win rate, +20 effRating', pct(run(90, 70), (r) => r.favouredWon), 72, 78, '%');
  check(
    'Win rate, draft edge only',
    pct(run(70, 70, { blue: { compModifier: 1.06 }, red: { compModifier: 1.0 } }), (r) => r.favouredWon),
    55,
    58,
    '%',
  );
}

// --- shape of a game ---------------------------------------------------------
const lengths = equal.map((r) => r.gameLength / 60);
check('Mean game length', mean(lengths), 31, 34, ' min');
check('Game length stddev', stddev(lengths), 5, 7, ' min');
check('Decided before 20:00', pct(equal, (r) => r.gameLength < 20 * 60), 0, 8, '%');
check('Sudden death rate', pct(equal, (r) => r.endReason === 'SUDDEN_DEATH'), 0, 1, '%');
check('Mean kills per game', mean(equal.map(killsOf)), 22, 30, '');

// --- the narrative checks ----------------------------------------------------
const firstBloodWins = equal.filter((r) => {
  const fb = r.events.find((e) => e.type === 'FIRST_BLOOD');
  return fb && fb.team === r.winner;
}).length;
const firstBloodGames = equal.filter((r) => r.events.some((e) => e.type === 'FIRST_BLOOD')).length;
check('First-blood team win rate', (100 * firstBloodWins) / (firstBloodGames || 1), 56, 62, '%');

/** docs/04: the power weighting is working if the best player dies noticeably less. */
const deathRatios = equal.map((r) => {
  const ratios = ['BLUE', 'RED'].map((team) => {
    const side = r.boxScore.filter((row) => row.team === team);
    const best = side.reduce((a, b) => (a.effRating >= b.effRating ? a : b));
    const worst = side.reduce((a, b) => (a.effRating <= b.effRating ? a : b));
    return worst.deaths ? best.deaths / worst.deaths : 1;
  });
  return mean(ratios);
});
check('Best/worst player deaths', mean(deathRatios) * 100, 0, 60, '%');

// --- report ------------------------------------------------------------------
const green = '\x1b[32m';
const red = '\x1b[31m';
const dim = '\x1b[2m';
const reset = '\x1b[0m';

console.log(`\n  Balance matrix  ·  ${sims} sims per row\n`);
console.log(`  ${'target'.padEnd(30)} ${'value'.padStart(9)}   ${'window'.padEnd(16)} `);
console.log(`  ${'-'.repeat(62)}`);

for (const row of rows) {
  const value = `${row.value.toFixed(row.unit === '%' ? 1 : 2)}${row.unit}`;
  const window = `${row.low}–${row.high}${row.unit}`;
  console.log(
    `  ${row.name.padEnd(30)} ${value.padStart(9)}   ${dim}${window.padEnd(16)}${reset}`
    + ` ${row.pass ? `${green}pass` : `${red}FAIL`}${reset}`,
  );
}

const failed = rows.filter((r) => !r.pass);
console.log(`\n  ${failed.length ? `${red}${failed.length} failing${reset}` : `${green}all green${reset}`}\n`);
process.exit(failed.length ? 1 : 0);
