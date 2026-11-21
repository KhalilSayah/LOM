/**
 * Lane phase: pressure, plates, the first turret, and ganks.
 *
 * docs/04 section 6.2. Pressure is an accumulator rather than an event roll, which is
 * what makes a lane lead feel like a lead — it builds, it shows up as plates, and it
 * eventually becomes a turret. A coin flip every tick would produce the same gold
 * with none of the story.
 */

import { BALANCE, phaseAt } from './balance.js';
import { economyAwardPlate, economyAwardTower } from './structures.js';
import { contestPower, resolve } from './power.js';
import { aliveOf, meanConsistency, assignDeaths, newFight, emitMultikills } from './combat.js';
import { jitter, LANE_ANCHOR } from './map.js';

const LANE_SLOTS = { TOP: ['TOP'], MID: ['MID'], BOT: ['BOT', 'SUP'] };

/**
 * An early kill is worth more than its gold.
 *
 * docs/04 section 9 wants the first-blood team to win 56-62% of games, and kill gold
 * alone cannot carry that: 300 gold is forty seconds of passive income. Momentum is
 * what makes an early lead feel like one, and it decays, so it never becomes a second
 * rating stat.
 */
function bumpLaneMomentum(winner, loser) {
  winner.momentum = Math.min(1, winner.momentum + BALANCE.momentum.gain);
  loser.momentum = Math.max(-1, loser.momentum - BALANCE.momentum.gain);
}

/**
 * Plates are finite and they expire: five a turret, gone at 14:00 (the rules preset's
 * `plates.until`). Without both limits a dominant lane prints "takes a plate" every
 * forty seconds for the whole game, which is wrong twice — the plating is long gone,
 * and the gold it keeps paying never stops.
 */
const platesLeft = (state, side, lane) =>
  state.t < state.rules.plates.until && state.opponent(side).structures[lane].plates < 5;

const lanePlayers = (side, lane) =>
  side.players.filter((p) => LANE_SLOTS[lane].includes(p.slot) && p.alive);

export function resolveLanePhase(state) {
  if (state.t >= BALANCE.phases.early) return;

  state.lanePressure ||= { TOP: 0, MID: 0, BOT: 0 };
  const phase = phaseAt(state.t);
  const { BLUE, RED } = state.sides;

  for (const lane of ['TOP', 'MID', 'BOT']) {
    const blue = lanePlayers(BLUE, lane);
    const red = lanePlayers(RED, lane);
    if (!blue.length || !red.length) continue;

    const bluePower = contestPower(BLUE, 'LANE', phase, blue, state.t);
    const redPower = contestPower(RED, 'LANE', phase, red, state.t);

    const edge = Math.tanh((bluePower - redPower) / BALANCE.lane.scale);
    state.lanePressure[lane] += edge * BALANCE.lane.pressureRate;

    const pressure = state.lanePressure[lane];
    const leader = pressure > 0 ? BLUE : RED;
    const magnitude = Math.abs(pressure);

    if (magnitude >= BALANCE.lane.towerThreshold) {
      // The turret is the end of the lane's story: the counter resets fully, because
      // there is no second outer turret to take.
      economyAwardTower(state, leader, lane);
      state.lanePressure[lane] = 0;
    } else if (magnitude >= BALANCE.lane.plateThreshold && platesLeft(state, leader, lane)) {
      economyAwardPlate(state, leader, lane);
      state.lanePressure[lane] = pressure * BALANCE.lane.plateReset;
    }

    rollGank(state, lane, blue, red);
  }
}

/**
 * A gank, per lane per tick.
 *
 * Losing lanes get ganked more, which is both what happens and what a player expects
 * to see: the jungler goes where there is something to collect.
 */
function rollGank(state, lane, blue, red) {
  const phase = phaseAt(state.t);
  const { BLUE, RED } = state.sides;
  const pressure = state.lanePressure[lane];

  for (const [side, enemy, mates, victims, sign] of [
    [BLUE, RED, blue, red, -1],
    [RED, BLUE, red, blue, 1],
  ]) {
    const jungler = side.players.find((p) => p.slot === 'JNG' && p.alive);
    if (!jungler || !victims.length) continue;

    // `sign * pressure` is positive when this side's lane is the losing one, which is
    // where the jungler is most likely to be needed and most likely to find a kill.
    const need = Math.max(0, sign * pressure) / BALANCE.lane.towerThreshold;
    const macro = ((jungler.subStats?.macro ?? 60) - 60) / 100;
    const p = BALANCE.lane.gankChance.base
      + BALANCE.lane.gankChance.pressure * need
      + BALANCE.lane.gankChance.macro * macro;

    if (!state.rng.chance(Math.max(0, p))) continue;

    const attackers = [jungler, ...mates];
    const counterJungler = enemy.players.find((p) => p.slot === 'JNG' && p.alive);
    const defenders = [...victims, ...(counterJungler ? [counterJungler] : [])];
    const pos = jitter(state.fx, LANE_ANCHOR[enemy.name][victims[0].slot], 900);

    const a = contestPower(side, 'GANK', phase, attackers, state.t);
    const d = contestPower(enemy, 'GANK', phase, defenders, state.t);
    const outcome = resolve(state.rng, a, d, meanConsistency(state));

    state.emit('GANK', {
      team: side.name,
      killer: jungler.name,
      lane,
      won: outcome.won,
      victim: victims[0].name,
      laner: mates[0]?.name,
      counter: Boolean(counterJungler),
      pos,
      actors: { participants: [...attackers, ...defenders].map((p2) => p2.pid) },
      payload: { lane, won: outcome.won },
    });

    // Everyone in the gank, both sides: victims come from one side of it and killers
    // from the other, so a failed gank is punished by the laner who read it and not by
    // whoever on that team happened to be strongest.
    const inGank = [...attackers, ...defenders];
    const fight = newFight('GANK', { lane, failed: !outcome.won });

    if (outcome.won) {
      const taken = state.rng.chance(0.25 + Math.abs(outcome.margin)) ? 2 : 1;
      assignDeaths(state, enemy, taken, phase, pos, inGank, fight);
      bumpLaneMomentum(side, enemy);
      state.lanePressure[lane] += -sign * BALANCE.lane.gankPressure * taken;
    } else {
      // A failed gank is a free kill for the lane that read it, and the single most
      // satisfying thing a vision stat can buy.
      assignDeaths(state, side, 1, phase, pos, inGank, fight);
      bumpLaneMomentum(enemy, side);
      state.lanePressure[lane] += sign * BALANCE.lane.gankPressure;
    }
    emitMultikills(state, fight);
  }
}

export { aliveOf };
