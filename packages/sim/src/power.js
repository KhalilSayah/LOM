/**
 * The power model and the one function that resolves every contest.
 *
 * docs/04 section 5. Everything in the engine that can go one way or the other goes
 * through `resolve()`, which means there is exactly one place to look when a balance
 * target moves, and exactly one place that decides how much a better squad is worth.
 */

import { BALANCE } from './balance.js';
import { classOf } from './champions.js';
import { expectedGold } from './economy.js';

const SUB_STATS = ['laning', 'teamfight', 'mechanics', 'macro', 'vision', 'consistency'];

const statsOf = (p) => {
  const s = p.subStats || {};
  // A missing sub-stat reads as average rather than zero: the pipeline may not have
  // measured it, and "unmeasured" must not mean "catastrophic".
  return SUB_STATS.map((k) => (Number.isFinite(s[k]) ? s[k] : 60));
};

/**
 * How much this player's spread suits this kind of fight, as a multiplier near 1.
 *
 * Expressed as a ratio against the player's own average rather than against the
 * field, so it measures specialisation — a 70-rated laner who is all laning is better
 * in lane than a 70-rated generalist, and worse in a teamfight. That is the shape
 * that makes sub-stats worth reading on a card.
 */
export function subStatWeight(p, kind) {
  const weights = BALANCE.contestWeights[kind] || {};
  const stats = statsOf(p);

  let weightedSum = 0;
  let weightTotal = 0;
  let plainSum = 0;

  SUB_STATS.forEach((key, i) => {
    const w = weights[key] || 1;
    weightedSum += stats[i] * w;
    weightTotal += w;
    plainSum += stats[i];
  });

  const plainMean = plainSum / SUB_STATS.length;
  if (plainMean <= 0) return 1;
  return weightedSum / weightTotal / plainMean;
}

/**
 * How far ahead of the curve this player's gold is, as a power multiplier.
 *
 * docs/04 section 5.1: the feedback loop that makes leads real without making them
 * absolute. A fed scaling carry gets most of the ceiling, a fed tank very little,
 * which is why killing the right person matters.
 */
export function goldFactor(p, t) {
  const expected = expectedGold(t, p.slot);
  if (expected <= 0) return 0;
  const raw = (p.gold - expected) / expected;
  const bounded = Math.min(BALANCE.goldFactor.ceiling, Math.max(BALANCE.goldFactor.floor, raw));
  return bounded * (BALANCE.scalingCoef[classOf(p.champion, p.slot)] ?? 1);
}

/** docs/04 section 5.1. A dead player contributes nothing — that is the whole point. */
export function playerPower(p, phase, t) {
  if (!p.alive) return 0;
  const curve = BALANCE.phaseCurve[classOf(p.champion, p.slot)] || BALANCE.phaseCurve.UTILITY;
  return (p.effRating + (p.chemistry || 0)) * curve[phase] * (1 + goldFactor(p, t));
}

/**
 * docs/04 section 5.4. Not a sub-stat: a derived modifier that only exists when the
 * stakes are high, so that "and that is why you pay him" has something behind it.
 */
export function clutchOf(p, population) {
  const z = (key) => {
    const values = population.map((o) => (o.subStats?.[key] ?? 60));
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
    return sd < 1e-9 ? 0 : ((p.subStats?.[key] ?? 60) - mean) / sd;
  };
  return 0.5 * z('mechanics') + 0.3 * z('consistency') + 0.2 * z('teamfight');
}

const strategyModifier = (strategy, kind, phase) => {
  const preset = BALANCE.strategy[strategy] || {};
  return (preset[kind] ?? 1) * (preset[phase] ?? 1);
};

const coachModifier = (coach, kind, phase) => {
  if (!coach) return 1;
  const byKind = coach[kind] ?? 1;
  const byPhase = coach[phase] ?? 1;
  return byKind * byPhase;
};

/**
 * The power a side brings to one contest (docs/04 section 5.2).
 *
 * The mean, not the sum, so a 5v3 is not automatically won by having bodies — being
 * outnumbered costs you through the dead players contributing zero elsewhere, not
 * through arithmetic here.
 */
export function contestPower(side, kind, phase, participants, t, opts = {}) {
  const alive = participants.filter((p) => p.alive);
  if (!alive.length) return 0;

  const mean = alive.reduce((n, p) => n + playerPower(p, phase, t) * subStatWeight(p, kind), 0) / alive.length;

  let power = mean
    * side.comp.modifier
    * strategyModifier(side.strategy, kind, phase)
    * coachModifier(side.coach, kind, phase)
    * (1 + side.momentum * BALANCE.momentum.weight)
    * (1 + side.buffs());

  if (opts.highStakes) {
    const clutch = alive.reduce((n, p) => n + p.clutch, 0) / alive.length;
    power *= 1 + Math.max(-1, Math.min(1, clutch)) * BALANCE.clutch.weight;
  }

  if (opts.defenderBonus) power *= opts.defenderBonus;

  return power;
}

/**
 * One logistic, every contest (docs/04 section 5.5).
 *
 * The clamp is the most important line in the engine: an 8% floor means the underdog
 * always has a story, and it is what stops a stacked collection from producing a
 * perfect season. The consistency term flattens the curve for steady teams rather
 * than shifting it, so consistency buys reliability, never free wins.
 */
export function resolve(rng, attackerPower, defenderPower, meanConsistency) {
  const kEff = BALANCE.k
    * (BALANCE.consistencyK.base + BALANCE.consistencyK.span * (meanConsistency / 99));

  const d = attackerPower - defenderPower;
  const raw = 1 / (1 + Math.exp((-kEff * d) / BALANCE.sigma));
  const pWin = Math.min(BALANCE.winCeiling, Math.max(BALANCE.winFloor, raw));

  return { pWin, won: rng.chance(pWin), margin: pWin - 0.5 };
}

export { SUB_STATS };
