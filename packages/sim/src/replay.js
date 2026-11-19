/**
 * Turning an event log into something that can be drawn.
 *
 * docs/04 section 8: the replay interpolates each champion between the last two
 * events that mention them, falling back to a per-slot lane anchor and a
 * phase-dependent grouping anchor. That fallback is most of the work — only combat
 * and objective events carry a position, so without it eight of the ten dots would
 * sit still for ninety seconds at a time.
 *
 * Pure, like the rest of the engine: it takes a SimResult and returns a function of
 * time. No canvas, no DOM, no clock — the renderer owns all three.
 */

import { LANE_ANCHOR, REGIONS } from './map.js';
import { BALANCE, phaseAt } from './balance.js';
import { respawnTime } from './economy.js';

/** Longer than this between real sightings and the dot drifts home. */
const DRIFT_AFTER = 40;

const lerp = (a, b, f) => a + (b - a) * f;

/**
 * Where a player is when nothing says otherwise.
 *
 * Early that is their lane; later it is wherever the team is likely grouped, which
 * keeps five dots from standing in five lanes at 30 minutes while a baron fight is
 * happening somewhere else.
 */
function anchorFor(player, t) {
  const phase = phaseAt(t);
  const lane = LANE_ANCHOR[player.team][player.slot];
  if (phase === 'EARLY') return lane;

  const group = player.team === 'BLUE' ? REGIONS.BLUE_JUNGLE : REGIONS.RED_JUNGLE;
  const pull = phase === 'MID' ? 0.45 : 0.7;
  return { x: lerp(lane.x, group.x, pull), y: lerp(lane.y, group.y, pull) };
}

/**
 * Build one track per player: a sorted list of (t, pos) the renderer interpolates
 * through, plus the windows where that player is dead.
 */
export function buildTracks(result, roster) {
  const tracks = new Map();

  for (const player of roster) {
    tracks.set(player.pid, { player, keys: [{ t: 0, pos: LANE_ANCHOR[player.team][player.slot] }], dead: [] });
  }

  for (const event of result.events) {
    if (!event.pos || !event.actors) continue;

    const mentioned = [
      event.actors.killer,
      event.actors.victim,
      ...(event.actors.assists || []),
      ...(event.actors.participants || []),
    ].filter(Boolean);

    for (const pid of new Set(mentioned)) {
      const track = tracks.get(pid);
      if (!track) continue;
      track.keys.push({ t: event.t, pos: event.pos });
    }

    // A death is a hole in the track: the dot goes to base and stops being a threat
    // on the map, which is the single most readable thing in a replay.
    if (event.actors.victim && (event.type === 'KILL' || event.type === 'FIRST_BLOOD')) {
      const track = tracks.get(event.actors.victim);
      if (track) track.dead.push({ from: event.t, to: event.t + respawnTime(event.t) });
    }
  }

  for (const track of tracks.values()) {
    track.keys.sort((a, b) => a.t - b.t);
    // Drop duplicate timestamps: two events in the same second would make the
    // interpolation divide by zero.
    track.keys = track.keys.filter((key, i, all) => i === 0 || key.t !== all[i - 1].t);
  }

  return tracks;
}

const BASE = {
  BLUE: { x: 1100, y: 1100 },
  RED: { x: 13770, y: 13770 },
};

/** Where every player is at time t, and whether they are alive. */
export function positionsAt(tracks, t) {
  const out = [];

  for (const track of tracks.values()) {
    const { player, keys, dead } = track;

    const grave = dead.find((window) => t >= window.from && t < window.to);
    if (grave) {
      out.push({ ...player, alive: false, pos: BASE[player.team], respawnIn: Math.round(grave.to - t) });
      continue;
    }

    let before = keys[0];
    let after = null;
    for (const key of keys) {
      if (key.t <= t) before = key;
      else { after = key; break; }
    }

    const anchor = anchorFor(player, t);
    let pos;

    if (!after) {
      // Past the last sighting: drift home over DRIFT_AFTER seconds and stay there.
      const f = Math.min(1, (t - before.t) / DRIFT_AFTER);
      pos = { x: lerp(before.pos.x, anchor.x, f), y: lerp(before.pos.y, anchor.y, f) };
    } else if (after.t - before.t > DRIFT_AFTER * 2) {
      // A long gap: home, then out to wherever they turn up next, rather than one
      // slow diagonal across the map that no player ever walked.
      const half = (before.t + after.t) / 2;
      const f = t <= half
        ? (t - before.t) / (half - before.t)
        : (t - half) / (after.t - half);
      pos = t <= half
        ? { x: lerp(before.pos.x, anchor.x, f), y: lerp(before.pos.y, anchor.y, f) }
        : { x: lerp(anchor.x, after.pos.x, f), y: lerp(anchor.y, after.pos.y, f) };
    } else {
      const f = (t - before.t) / (after.t - before.t);
      pos = { x: lerp(before.pos.x, after.pos.x, f), y: lerp(before.pos.y, after.pos.y, f) };
    }

    out.push({ ...player, alive: true, pos, respawnIn: 0 });
  }

  return out;
}

/** The structures still standing at time t, replayed from the event log. */
export function structuresAt(result, t) {
  const state = {
    BLUE: { TOP: { towers: 3, inhibitor: true }, MID: { towers: 3, inhibitor: true }, BOT: { towers: 3, inhibitor: true }, nexusTurrets: 2, nexus: true },
    RED: { TOP: { towers: 3, inhibitor: true }, MID: { towers: 3, inhibitor: true }, BOT: { towers: 3, inhibitor: true }, nexusTurrets: 2, nexus: true },
  };

  const laneOf = (narration) =>
    narration.includes('TOP') ? 'TOP' : narration.includes('BOT') ? 'BOT' : 'MID';

  for (const event of result.events) {
    if (event.t > t || !event.team) continue;
    const defender = event.team === 'BLUE' ? 'RED' : 'BLUE';

    if (event.type === 'TOWER') state[defender][laneOf(event.narration)].towers -= 1;
    if (event.type === 'INHIBITOR') state[defender][laneOf(event.narration)].inhibitor = false;
    if (event.type === 'NEXUS_TURRET') state[defender].nexusTurrets -= 1;
    if (event.type === 'NEXUS') state[defender].nexus = false;
  }

  return state;
}

/** The score, gold difference and live buffs at time t, for the scoreboard. */
export function scoreAt(result, t) {
  const kills = { BLUE: 0, RED: 0 };
  const dragons = { BLUE: 0, RED: 0 };
  const buffs = { BLUE: [], RED: [] };

  for (const event of result.events) {
    if (event.t > t) break;
    if ((event.type === 'KILL' || event.type === 'FIRST_BLOOD') && event.team) kills[event.team] += 1;
    if (event.type === 'DRAGON' && event.team) dragons[event.team] += 1;
    if (event.type === 'BARON' && event.team) buffs[event.team].push({ kind: 'BARON', until: event.t + 180 });
    if (event.type === 'ELDER' && event.team) buffs[event.team].push({ kind: 'ELDER', until: event.t + 150 });
    if (event.type === 'SOUL' && event.team) buffs[event.team].push({ kind: 'SOUL', until: Infinity });
  }

  const sample = [...result.timeline].reverse().find((s) => s.t <= t) || result.timeline[0];

  return {
    kills,
    dragons,
    goldDiff: sample?.goldDiff ?? 0,
    buffs: {
      BLUE: buffs.BLUE.filter((b) => b.until > t).map((b) => b.kind),
      RED: buffs.RED.filter((b) => b.until > t).map((b) => b.kind),
    },
  };
}

export { BALANCE };
