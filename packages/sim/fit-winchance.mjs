/**
 * Fits the replay's win-chance line (replay.js WIN_MODEL) to this engine.
 *
 *   node packages/sim/fit-winchance.mjs            # 12000 matches
 *   node packages/sim/fit-winchance.mjs --sims 30000
 *
 * Plays a spread of matches — squads 0 to 20 rating points apart, drafts a few points
 * either way — and fits one logistic regression from every minute's sample to who won
 * in the end. Prints a WIN_MODEL to paste over the one in src/replay.js, and how well
 * it is calibrated. Rerun it whenever a balance pass moves what a lead is worth.
 */

import { simulate } from './src/index.js';
import { winPriors, winFeatures, winChance, WIN_MODEL } from './src/replay.js';
import { makeTeam } from './fixtures/teams.mjs';
import { createRng } from './src/rng.js';

const args = process.argv.slice(2);
const sims = Number(args[args.indexOf('--sims') + 1]) || 12000;
const pick = createRng('fit-winchance');

const X = [];
const Y = [];

for (let i = 0; i < sims; i++) {
  const base = 66 + pick.int(0, 16);
  const gap = pick.int(-10, 10);
  const comp = () => 0.96 + pick.float() * 0.08;
  const blue = makeTeam('blue', base + Math.max(0, gap), { compModifier: comp() });
  const red = makeTeam('red', base + Math.max(0, -gap), { compModifier: comp() });
  const result = simulate({ seed: `fit-${i}`, blue, red });
  const priors = winPriors(result);
  const y = result.winner === 'BLUE' ? 1 : 0;
  // The last sample is taken after the nexus falls; it would teach the model nothing
  // but "a destroyed base loses".
  for (const sample of result.timeline.slice(0, -1)) {
    X.push(winFeatures(priors, sample));
    Y.push(y);
  }
}

const dims = X[0].length;
const w = new Array(dims).fill(0);
const m = new Array(dims).fill(0);
const v = new Array(dims).fill(0);
const lr = 0.05;
const l2 = 1e-4;

// Adam over the whole batch: small, deterministic, and plenty for fourteen weights.
for (let step = 1; step <= 600; step++) {
  const grad = new Array(dims).fill(0);
  for (let n = 0; n < X.length; n++) {
    const z = X[n].reduce((s, x, j) => s + x * w[j], 0);
    const p = 1 / (1 + Math.exp(-z));
    const e = p - Y[n];
    for (let j = 0; j < dims; j++) grad[j] += e * X[n][j];
  }
  for (let j = 0; j < dims; j++) {
    const g = grad[j] / X.length + l2 * w[j];
    m[j] = 0.9 * m[j] + 0.1 * g;
    v[j] = 0.999 * v[j] + 0.001 * g * g;
    const mh = m[j] / (1 - 0.9 ** step);
    const vh = v[j] / (1 - 0.999 ** step);
    w[j] -= (lr * mh) / (Math.sqrt(vh) + 1e-8);
    // A lead never counts against the side holding it: gold and turrets move together,
    // and without this the fit trades one against the other into a negative weight.
    if (j >= 2) w[j] = Math.max(0, w[j]);
  }
}

const k = WIN_MODEL.knots.length;
const round = (x) => Number(x.toFixed(4));
const model = {
  knots: WIN_MODEL.knots,
  rating: round(w[0]),
  comp: round(w[1]),
  gold: w.slice(2, 2 + k).map(round),
  structures: w.slice(2 + k, 2 + 2 * k).map(round),
};

// Calibration: predicted against observed, in deciles.
const buckets = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
let logLoss = 0;
for (let n = 0; n < X.length; n++) {
  const z = X[n].reduce((s, x, j) => s + x * w[j], 0);
  const p = 1 / (1 + Math.exp(-z));
  const b = buckets[Math.min(9, Math.floor(p * 10))];
  b.n += 1; b.p += p; b.y += Y[n];
  logLoss -= Y[n] ? Math.log(p) : Math.log(1 - p);
}

console.log(`\n  ${sims} matches, ${X.length} samples, log loss ${(logLoss / X.length).toFixed(4)}\n`);
for (const [i, b] of buckets.entries()) {
  if (!b.n) continue;
  console.log(`  ${String(i * 10).padStart(3)}-${String(i * 10 + 10).padEnd(3)}%  predicted ${(100 * b.p / b.n).toFixed(1).padStart(5)}%  observed ${(100 * b.y / b.n).toFixed(1).padStart(5)}%  (${b.n})`);
}
console.log(`\nexport const WIN_MODEL = ${JSON.stringify(model, null, 2).replace(/"(\w+)":/g, '$1:')};\n`);
// Keeps the import honest: the shipped model and this one read the same features.
void winChance;
