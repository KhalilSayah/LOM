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

/**
 * Where every structure stands: per lane the outer, inner and inhibitor turrets and
 * then the inhibitor, plus the two nexus turrets and the nexus.
 *
 * Blue's are written out; red's are blue's rotated 180 degrees about the centre. That
 * rotation sends the left edge (blue's top lane) to the right edge, which is red's
 * *bot* lane, so red's top structures are the mirror of blue's bot ones and vice versa.
 * Walking a step diagonally from a base, which is what this used to do, put blue's
 * turrets in the river and red's top turrets in the bot lane.
 *
 * The map renderer draws from this same table, so a falling turret and the ring that
 * marks it are always in the same place.
 */
const BLUE_STRUCTURES = {
  TOP: [{ x: 980, y: 10440 }, { x: 1180, y: 6430 }, { x: 1180, y: 4400 }, { x: 1050, y: 3700 }],
  MID: [{ x: 5850, y: 6400 }, { x: 5050, y: 4800 }, { x: 3900, y: 3600 }, { x: 3300, y: 3200 }],
  BOT: [{ x: 10500, y: 1050 }, { x: 6900, y: 1220 }, { x: 4300, y: 1220 }, { x: 3700, y: 1050 }],
  nexusTurrets: [{ x: 1750, y: 2270 }, { x: 2180, y: 1810 }],
  nexus: { x: 1500, y: 1500 },
};

const rotate = ({ x, y }) => ({ x: MAP_MAX - x, y: MAP_MAX - y });

export const STRUCTURES = {
  BLUE: BLUE_STRUCTURES,
  RED: {
    TOP: BLUE_STRUCTURES.BOT.map(rotate),
    MID: BLUE_STRUCTURES.MID.map(rotate),
    BOT: BLUE_STRUCTURES.TOP.map(rotate),
    nexusTurrets: BLUE_STRUCTURES.nexusTurrets.map(rotate),
    nexus: rotate(BLUE_STRUCTURES.nexus),
  },
};

/**
 * The position of a structure belonging to `team`: index 0-2 the lane's turrets from
 * the outside in, 3 its inhibitor, 4 a nexus turret, 5 the nexus.
 */
export function structurePos(team, lane, index) {
  const built = STRUCTURES[team] || STRUCTURES.BLUE;
  if (index >= 5) return { ...built.nexus };
  if (index === 4) return { ...built.nexusTurrets[lane === 'BOT' ? 1 : 0] };
  const row = built[lane] || built.MID;
  return { ...row[Math.max(0, Math.min(3, index))] };
}

/** How the commentary says a region, with BLUE and RED left for the viewer to name. */
export const REGION_TEXT = {
  TOP_LANE: 'the top lane',
  BOT_LANE: 'the bot lane',
  MID_LANE: 'the mid lane',
  BLUE_JUNGLE: "BLUE's jungle",
  RED_JUNGLE: "RED's jungle",
  DRAGON_PIT: 'the dragon pit',
  BARON_PIT: 'the Baron pit',
  BLUE_BASE: "BLUE's base",
  RED_BASE: "RED's base",
};

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
