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
  }
}

/** docs/04 section 7: 8 seconds early, up to a minute in the late game. */
export function respawnTime(t) {
  const { base, perMinute, min, max } = economy.respawn;
  return Math.min(max, Math.max(min, base + (perMinute * t) / 60));
}

export function awardKill(killer, victim, assists, t) {
  killer.gold += economy.kill;
  killer.kills += 1;
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

/** Gold is the only ledger; CS is read back out of it for the box score. */
export function creepScore(player, t) {
  const earned = player.gold - economy.kill * player.kills - economy.assist * player.assists;
  return Math.max(0, Math.round(earned / economy.goldPerCs));
}

export const teamGold = (side) => side.players.reduce((n, p) => n + p.gold, 0);
