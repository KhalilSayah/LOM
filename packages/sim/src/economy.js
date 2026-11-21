/**
 * Gold, respawns, and the CS the box score reports.
 *
 * docs/04 section 7. CS is back-computed from gold rather than simulated: the engine
 * stays small, the numbers stay plausible, and nobody has ever asked a manager to
 * explain a creep.
 */

import { BALANCE } from './balance.js';

const { economy } = BALANCE;

/** The curve a slot is expected to be on at time t — the baseline goldFactor reads. */
export function expectedGold(t, slot) {
  return (economy.baselineGpm[slot] ?? 350) * (t / 60);
}

/** Passive and creeps for one tick. Everything else is earned by doing something. */
export function advanceEconomy(state) {
  const seconds = BALANCE.tick;
  for (const p of state.players) {
    p.gold += ((economy.baselineGpm[p.slot] ?? 350) / 60) * seconds;
    farm(state, p, seconds);
  }
}

const LANE_OF = { TOP: 'TOP', MID: 'MID', BOT: 'BOT', SUP: 'BOT' };

/**
 * Creeps, counted on their own ledger.
 *
 * CS used to be read back out of gold, which meant every gold source — kills, plates,
 * dragons, the passive tick — turned into creeps, and a support finished on twenty a
 * minute. Now it is minions and camps only: a rate per role, nothing while dead, a
 * little more for a good laner and for the side winning the lane. No random draw, so
 * it can never move an outcome.
 */
function farm(state, p, seconds) {
  if (!p.alive || state.t < economy.csFrom) return;
  const rate = economy.csPerMin[p.slot] ?? 7;

  const laning = Number.isFinite(p.subStats?.laning) ? p.subStats.laning : 60;
  let factor = 1 + (laning - 70) / 260 + ((p.effRating ?? 75) - 75) / 420;

  const lane = LANE_OF[p.slot];
  if (lane && state.lanePressure && state.t < BALANCE.phases.early) {
    const sign = p.team === 'BLUE' ? 1 : -1;
    factor += 0.07 * Math.tanh((sign * state.lanePressure[lane]) / BALANCE.lane.towerThreshold);
  }

  p.cs += (rate / 60) * seconds * Math.max(0.8, Math.min(1.2, factor));
}

/** docs/04 section 7: 8 seconds early, up to a minute in the late game. */
export function respawnTime(t) {
  const { base, perMinute, min, max } = economy.respawn;
  return Math.min(max, Math.max(min, base + (perMinute * t) / 60));
}

export function awardKill(killer, victim, assists, t) {
  killer.gold += economy.kill;
  killer.kills += 1;
  killer.streak = (killer.streak || 0) + 1;
  victim.streak = 0;
  victim.deaths += 1;
  victim.alive = false;
  victim.respawnAt = t + respawnTime(t);

  if (assists.length) {
    const share = economy.assist / assists.length;
    for (const a of assists) {
      a.gold += share;
      a.assists += 1;
    }
  }
}

export function awardTeam(side, amount) {
  for (const p of side.players) p.gold += amount / 5;
}

/** CS for the box score: the farm ledger, or for an old caller, read back out of gold. */
export function creepScore(player) {
  if (Number.isFinite(player.cs)) return Math.max(0, Math.round(player.cs));
  const earned = player.gold - economy.kill * player.kills - economy.assist * player.assists;
  return Math.max(0, Math.round(earned / economy.goldPerCs));
}

export const teamGold = (side) => side.players.reduce((n, p) => n + p.gold, 0);
