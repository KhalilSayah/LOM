/**
 * Summoner's Rift coordinates, 0..14870 on both axes (docs/04 section 8).
 *
 * Every combat event carries a position so the replay can interpolate champion dots
 * between the last two events that mention them. Without positions the replay is a
 * list of sentences; with them it is a map, which is the payoff of the daily loop.
 *
 * Blue is bottom-left, red is top-right, in the orientation every League player
 * already has in their head.
 */

export const MAP_MAX = 14870;

const mid = MAP_MAX / 2;

/** Where a slot sits when nothing else is happening. */
export const LANE_ANCHOR = {
  BLUE: {
    TOP: { x: 1600, y: 10200 },
    JNG: { x: 5200, y: 6200 },
    MID: { x: 6600, y: 6600 },
    BOT: { x: 10200, y: 1600 },
    SUP: { x: 10600, y: 2000 },
  },
  RED: {
    TOP: { x: 4200, y: 13000 },
    JNG: { x: 9400, y: 8400 },
    MID: { x: 8200, y: 8200 },
    BOT: { x: 13000, y: 4200 },
    SUP: { x: 12600, y: 3800 },
  },
};

/** Named places a fight can break out, with the phase that favours each. */
export const REGIONS = {
  TOP_LANE: { x: 2400, y: 11600, phases: ['EARLY', 'MID'] },
  BOT_LANE: { x: 11600, y: 2400, phases: ['EARLY', 'MID'] },
  MID_LANE: { x: mid, y: mid, phases: ['EARLY', 'MID', 'LATE'] },
  BLUE_JUNGLE: { x: 4200, y: 7600, phases: ['EARLY', 'MID'] },
  RED_JUNGLE: { x: 10400, y: 7000, phases: ['EARLY', 'MID'] },
  DRAGON_PIT: { x: 9800, y: 4400, phases: ['EARLY', 'MID', 'LATE'] },
  BARON_PIT: { x: 4900, y: 10100, phases: ['MID', 'LATE'] },
  BLUE_BASE: { x: 1800, y: 1800, phases: ['LATE'] },
  RED_BASE: { x: 13000, y: 13000, phases: ['LATE'] },
};

export const OBJECTIVE_POS = {
  DRAGON: REGIONS.DRAGON_PIT,
  ELDER: REGIONS.DRAGON_PIT,
  SOUL: REGIONS.DRAGON_PIT,
  BARON: REGIONS.BARON_PIT,
  HERALD: REGIONS.BARON_PIT,
  SCUTTLE: { x: 7400, y: 4200 },
};

/** Structures fall from the outside in, so their positions walk up the lane. */
export function structurePos(team, lane, index) {
  const towards = team === 'BLUE' ? 1 : -1;
  const base = lane === 'TOP'
    ? { x: 1800, y: 7000 }
    : lane === 'BOT'
      ? { x: 7000, y: 1800 }
      : { x: 5600, y: 5600 };

  const step = 1700 * index * towards;
  const raw = team === 'BLUE'
    ? { x: base.x + step, y: base.y + step }
    : { x: MAP_MAX - base.x - step, y: MAP_MAX - base.y - step };

  // Clamped, because the nexus is five steps in from an outer turret and the
  // arithmetic walks off the map before it gets there. An off-map coordinate is not
  // a cosmetic problem: the replay interpolates dots between event positions, so one
  // bad point drags a champion across the river and back.
  return {
    x: Math.max(0, Math.min(MAP_MAX, raw.x)),
    y: Math.max(0, Math.min(MAP_MAX, raw.y)),
  };
}

/** A region, chosen for the phase, for a fight that has no objective to anchor it. */
export function regionFor(rng, phase) {
  const names = Object.keys(REGIONS).filter((n) => REGIONS[n].phases.includes(phase));
  const name = rng.pick(names);
  return { name, ...REGIONS[name] };
}

/** A little scatter, so ten dots do not stack on one pixel. */
export function jitter(rng, pos, spread = 700) {
  return {
    x: Math.max(0, Math.min(MAP_MAX, Math.round(pos.x + rng.int(-spread, spread)))),
    y: Math.max(0, Math.min(MAP_MAX, Math.round(pos.y + rng.int(-spread, spread)))),
  };
}
