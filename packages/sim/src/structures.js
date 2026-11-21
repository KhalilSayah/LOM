/**
 * Plates, turrets, inhibitors, and the way a won fight becomes a won game.
 *
 * docs/04 section 6.5. The conversion is the hinge of the whole engine: fights that
 * never become structures produce a 55-minute game, and structures that come too
 * cheaply produce a 19-minute one. If the game-length targets in section 9 miss, this
 * file and `BALANCE.siege` are where to look first.
 */

import { BALANCE } from './balance.js';
import { awardTeam } from './economy.js';
import { structurePos } from './map.js';

const TOWER_NAMES = ['outer turret', 'inner turret', 'inhibitor turret'];
const LANES = ['TOP', 'MID', 'BOT'];

const LANE_SLOTS = { TOP: ['TOP'], MID: ['MID'], BOT: ['BOT', 'SUP'] };

/** Who is standing at a structure when it falls, so the dots on the map go there. */
function takersFor(side, lane, takers) {
  if (takers?.length) return takers.filter((p) => p.alive);
  const inLane = side.players.filter((p) => p.alive && LANE_SLOTS[lane]?.includes(p.slot));
  return inLane.length ? inLane : side.players.filter((p) => p.alive);
}

export function economyAwardPlate(state, side, lane) {
  const local = side.players.find((p) => (lane === 'BOT' ? p.slot === 'BOT' : p.slot === lane));
  if (local) local.gold += BALANCE.economy.plate;
  const defender = state.opponent(side);
  defender.structures[lane].plates += 1;

  state.emit('PLATE', {
    team: side.name,
    lane,
    player: local?.name,
    count: defender.structures[lane].plates,
    pos: structurePos(defender.name, lane, 0),
    actors: { participants: takersFor(side, lane).map((p) => p.pid) },
    payload: { lane },
  });
}

/** One structure on one lane, in order, with the gold that goes with it. */
export function economyAwardTower(state, side, lane, opts = {}) {
  const defender = state.opponent(side);
  const built = defender.structures[lane];

  if (built.towers > 0) {
    const index = 3 - built.towers;
    built.towers -= 1;

    awardTeam(side, BALANCE.economy.towerTeam);
    const local = side.players.find((p) => (lane === 'BOT' ? p.slot === 'BOT' : p.slot === lane));
    if (local) local.gold += BALANCE.economy.towerLocal;

    const first = !state.firstTower;
    state.firstTower = true;
    state.emit('TOWER', {
      team: side.name,
      lane,
      structure: TOWER_NAMES[index],
      index,
      first,
      herald: opts.herald,
      player: local?.name,
      pos: structurePos(defender.name, lane, index),
      actors: { participants: takersFor(side, lane, opts.takers).map((p) => p.pid) },
      payload: { lane, index, remaining: built.towers, ...(first ? { first: true } : {}) },
    });
    return true;
  }

  if (built.inhibitor) {
    built.inhibitor = false;
    awardTeam(side, BALANCE.economy.towerTeam);
    const down = LANES.filter((l) => !defender.structures[l].inhibitor).length;
    state.emit('INHIBITOR', {
      team: side.name,
      lane,
      count: down,
      pos: structurePos(defender.name, lane, 3),
      actors: { participants: takersFor(side, lane, opts.takers).map((p) => p.pid) },
      payload: { lane },
    });
    return true;
  }

  return false;
}

const inhibitorDown = (side) => LANES.some((lane) => !side.structures[lane].inhibitor);

/**
 * Spend a push window.
 *
 * Pressure goes to the lane that is already furthest in, which is what a team with a
 * numbers advantage actually does — and it is what makes an inhibitor a milestone
 * rather than an accident.
 */
export function takeStructures(state, side, count, opts = {}) {
  const defender = state.opponent(side);
  const everyone = () => side.players.filter((p) => p.alive).map((p) => p.pid);

  for (let i = 0; i < count; i++) {
    if (!defender.structures.nexus) return;

    if (!defender.structures.nexusTurrets && inhibitorDown(defender)) {
      defender.structures.nexus = false;
      state.emit('NEXUS', {
        team: side.name,
        minutes: Math.round(state.t / 60),
        pos: structurePos(defender.name, 'MID', 5),
        actors: { participants: everyone() },
      });
      state.winner = side.name;
      state.endReason = 'NEXUS';
      return;
    }

    if (inhibitorDown(defender) && defender.structures.nexusTurrets > 0) {
      defender.structures.nexusTurrets -= 1;
      state.emit('NEXUS_TURRET', {
        team: side.name,
        remaining: defender.structures.nexusTurrets,
        pos: structurePos(defender.name, defender.structures.nexusTurrets ? 'TOP' : 'BOT', 4),
        actors: { participants: everyone() },
        payload: { remaining: defender.structures.nexusTurrets },
      });
      continue;
    }

    // The lane that is furthest in, inhibitor last: a standing inhibitor is worth
    // less than the turret in front of the next one.
    const open = LANES
      .filter((lane) => defender.structures[lane].towers > 0 || defender.structures[lane].inhibitor)
      .sort((a, b) => {
        const left = defender.structures[a];
        const right = defender.structures[b];
        return left.towers - right.towers || Number(left.inhibitor) - Number(right.inhibitor);
      });

    if (!open.length) return;
    economyAwardTower(state, side, open[0], opts);
  }
}

/** docs/04 section 6.5: the multiplier a buff puts on a push window. */
export function siegeMultiplier(side, t) {
  let m = 1;
  if (side.baronUntil > t) m *= BALANCE.siege.baron;
  if (side.elderUntil > t) m *= BALANCE.siege.elder;
  return m;
}

/** Convert whatever each side banked this tick into structures. */
export function resolveSieges(state) {
  for (const side of [state.sides.BLUE, state.sides.RED]) {
    if (side.pushOpportunity <= 0) continue;

    const spread = BALANCE.siege.jitter;
    const effective = side.pushOpportunity
      * siegeMultiplier(side, state.t)
      * (1 - spread + state.rng.float() * spread * 2);
    const taken = Math.floor(effective / BALANCE.siege.secondsPerStructure);

    // Past the lane phase a push is the whole team, and the dots should all go.
    const takers = state.t >= BALANCE.phases.early ? side.players.filter((p) => p.alive) : null;
    if (taken > 0) takeStructures(state, side, taken, { takers });
    side.pushOpportunity = 0;
    if (state.winner) return;
  }
}

export { LANES, inhibitorDown };
