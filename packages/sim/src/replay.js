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

import { LANE_ANCHOR, REGIONS, MAP_MAX } from './map.js';
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
const SLOT_ORDER = ['TOP', 'JNG', 'MID', 'BOT', 'SUP'];

/**
 * A small fixed offset per player, so five people standing at one event's position
 * read as a group of five dots rather than one. Presentation only: the same for a
 * player all game, and nothing in the engine sees it.
 */
function spreadFor(player) {
  const i = Math.max(0, SLOT_ORDER.indexOf(player.slot));
  const angle = (i / 5) * Math.PI * 2 + (player.team === 'RED' ? Math.PI / 5 : 0);
  return { x: Math.cos(angle) * 320, y: Math.sin(angle) * 320 };
}

const clampMap = (v) => Math.max(0, Math.min(MAP_MAX, v));

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
      const off = spreadFor(track.player);
      track.keys.push({ t: event.t, pos: { x: clampMap(event.pos.x + off.x), y: clampMap(event.pos.y + off.y) } });
    }

    // A death is a hole in the track: the dot goes to base and stops being a threat
    // on the map, which is the single most readable thing in a replay. The engine
    // says when the player came back; a result from before it did is estimated.
    if (event.actors.victim && (event.type === 'KILL' || event.type === 'FIRST_BLOOD')) {
      const track = tracks.get(event.actors.victim);
      const back = event.payload?.respawnAt;
      const to = Number.isFinite(back) ? Math.max(back, event.t + 2) : event.t + respawnTime(event.t);
      if (track) track.dead.push({ from: event.t, to });
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

  for (const event of result.events) {
    if (event.t > t || !event.team) continue;
    const defender = event.team === 'BLUE' ? 'RED' : 'BLUE';
    const side = state[defender];

    if (event.type === 'TOWER') {
      const lane = side[laneOfEvent(event)];
      lane.towers = Math.max(0, lane.towers - 1);
    }
    if (event.type === 'INHIBITOR') side[laneOfEvent(event)].inhibitor = false;
    if (event.type === 'NEXUS_TURRET') side.nexusTurrets = Math.max(0, side.nexusTurrets - 1);
    if (event.type === 'NEXUS') side.nexus = false;
  }

  return state;
}

/**
 * The lane a structure event happened in. Read off the event since 1.1.0; a result
 * from before then only says it in its commentary ("... in TOP"), so that is the
 * fallback, and never the other way round.
 */
export function laneOfEvent(event) {
  const lane = event.payload?.lane;
  if (lane === 'TOP' || lane === 'MID' || lane === 'BOT') return lane;
  const text = String(event.narration || '');
  return /\bTOP\b/.test(text) ? 'TOP' : /\bBOT\b/.test(text) ? 'BOT' : 'MID';
}

/**
 * The chance blue wins from here, read off one timeline sample.
 *
 * Not a guess and not the engine's own state: a logistic fitted to tens of thousands
 * of finished matches from this engine (packages/sim/fit-winchance.mjs), on what every
 * result has carried since 1.0.0 — the gold lead, the structures still standing, and
 * the two squads' ratings and drafts — so it draws for old results too. The weight of a
 * gold lead and of a fallen turret both change over a game; they are interpolated
 * between fitted knots in minutes.
 */
export const WIN_MODEL = {
  // Fitted on 10000 matches of sim 1.1.0; calibrated within two points in every decile
  // from 10% to 90%. Past twenty minutes the turrets carry what the gold lead says.
  knots: [0, 10, 20, 30, 40, 55],
  rating: 0.022,
  comp: 0.0229,
  gold: [0.0919, 0.0648, 0, 0, 0, 0.2106],
  structures: [0.1755, 0.1182, 0.2702, 0.2806, 0.2551, 0.028],
};

const knotWeights = (minutes) => {
  const k = WIN_MODEL.knots;
  const w = k.map(() => 0);
  if (minutes <= k[0]) { w[0] = 1; return w; }
  for (let i = 1; i < k.length; i++) {
    if (minutes <= k[i]) {
      const f = (minutes - k[i - 1]) / (k[i] - k[i - 1]);
      w[i - 1] = 1 - f;
      w[i] = f;
      return w;
    }
  }
  w[k.length - 1] = 1;
  return w;
};

/** The features the model reads from a result as a whole: the squads going in. */
export function winPriors(result) {
  const rows = result?.boxScore || [];
  const mean = (team) => {
    const side = rows.filter((r) => r.team === team && Number.isFinite(r.effRating));
    return side.length ? side.reduce((n, r) => n + r.effRating, 0) / side.length : 0;
  };
  const comp = (team) => Number(result?.composition?.[team]?.modifier) || 1;
  return {
    rating: mean('BLUE') - mean('RED'),
    comp: (comp('blue') - comp('red')) * 100,
  };
}

/** The feature vector for one sample; shared by the screen and the fitting script. */
export function winFeatures(priors, sample) {
  const minutes = (sample?.t || 0) / 60;
  const w = knotWeights(minutes);
  const gold = (sample?.goldDiff || 0) / 1000;
  const s = sample?.structures;
  const structures = s ? (s.blue ?? 0) - (s.red ?? 0) : 0;
  return [priors.rating, priors.comp, ...w.map((x) => x * gold), ...w.map((x) => x * structures)];
}

export function winChance(priors, sample, model = WIN_MODEL) {
  const f = winFeatures(priors, sample);
  const coef = [model.rating, model.comp, ...model.gold, ...model.structures];
  const z = f.reduce((n, x, i) => n + x * (coef[i] || 0), 0);
  return 1 / (1 + Math.exp(-z));
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
