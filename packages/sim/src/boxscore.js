/**
 * The box score, and the grade that is the point of it.
 *
 * docs/04 section 10. A grade is measured against what this card was *expected* to do
 * in this match, not against what it did in absolute terms — which is why a 70 OVR
 * support can take an S off a game full of 90s, and why the best card on the map
 * taking an A is information rather than an insult.
 */

import { BALANCE } from './balance.js';
import { gradeFor, zScore } from '../../core/src/index.js';
import { creepScore, teamGold } from './economy.js';

const slotDamageShare = { TOP: 0.21, JNG: 0.16, MID: 0.28, BOT: 0.29, SUP: 0.06 };

/**
 * Damage is modelled rather than simulated: a share of the team's output from the
 * slot, nudged by what the player actually did. The engine has no notion of an
 * ability hitting anything, and inventing one would buy a number nobody could check.
 */
function damageFor(p, minutes) {
  const base = (slotDamageShare[p.slot] ?? 0.2) * 100;
  // Floored well above zero: a player who fed all game still threw some damage out,
  // and a negative share would make the box score's percentages nonsense.
  const shaped = Math.max(base * 0.35, base + p.kills * 9 + p.assists * 3 - p.deaths * 2);
  return Math.round(shaped * Math.max(1, minutes) * 1.6);
}

function visionFor(p, minutes) {
  const skill = (p.subStats?.vision ?? 60) / 100;
  const slotWeight = p.slot === 'SUP' ? 2.6 : p.slot === 'JNG' ? 1.5 : 1;
  return Math.round(minutes * skill * slotWeight * 1.9);
}

export function buildBoxScore(state) {
  const minutes = state.t / 60;
  const rows = [];

  for (const side of [state.sides.BLUE, state.sides.RED]) {
    const teamKills = side.players.reduce((n, p) => n + p.kills, 0);
    const damageTotal = side.players.reduce((n, p) => n + damageFor(p, minutes), 0) || 1;
    const gold = teamGold(side) || 1;

    for (const p of side.players) {
      const damage = damageFor(p, minutes);
      rows.push({
        pid: p.pid,
        team: side.name,
        cardKey: p.cardKey,
        name: p.name,
        slot: p.slot,
        champion: p.champion,
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
        cs: creepScore(p),
        gold: Math.round(p.gold),
        damage,
        damageShare: Number((damage / damageTotal).toFixed(3)),
        goldShare: Number((p.gold / gold).toFixed(3)),
        vision: visionFor(p, minutes),
        killParticipation: teamKills ? Number(((p.kills + p.assists) / teamKills).toFixed(3)) : 0,
        effRating: p.effRating,
        ...(Number.isFinite(p.ovr) ? { ovr: p.ovr } : {}),
        ...(Number.isFinite(p.mastery) ? { mastery: p.mastery } : {}),
      });
    }
  }

  return gradeRows(rows, minutes, state.winner);
}

/**
 * What a role is expected to produce, and what each part of a game is worth to it.
 * A support is judged on being in the fights and lighting the map, a carry on damage
 * and farm; everyone on staying alive.
 */
const ROLE_LINE = {
  TOP: { cs: 7.6, w: { kda: 1, kp: 0.7, dmg: 1, cs: 0.6, vis: 0 } },
  JNG: { cs: 5.8, w: { kda: 1, kp: 1.2, dmg: 0.6, cs: 0.3, vis: 0.3 } },
  MID: { cs: 8.7, w: { kda: 1, kp: 0.8, dmg: 1.1, cs: 0.6, vis: 0 } },
  BOT: { cs: 9.0, w: { kda: 1, kp: 0.7, dmg: 1.1, cs: 0.7, vis: 0 } },
  SUP: { cs: 1.25, w: { kda: 0.9, kp: 1.5, dmg: 0.3, cs: 0, vis: 0.6 } },
};

/**
 * One number for how well a player played their role, before anyone is compared.
 * Every term is measured against what the role normally does, so a support's 2/3/18
 * and a carry's 9/2/5 can land in the same place.
 */
function performance(r, minutes) {
  const line = ROLE_LINE[r.slot] || ROLE_LINE.MID;
  const kda = Math.log((r.kills + 0.7 * r.assists + 1) / (r.deaths + 1));
  const kp = (r.killParticipation - 0.6) * 3;
  const dmg = (r.damageShare / (slotDamageShare[r.slot] ?? 0.2) - 1) * 2;
  const cs = (r.cs / Math.max(1, minutes) / line.cs - 1) * 4;
  const vis = (r.vision / Math.max(1, minutes) / (r.slot === 'SUP' ? 4.4 : r.slot === 'JNG' ? 2.6 : 1.7) - 1) * 1.5;
  const { w } = line;
  return w.kda * kda + w.kp * kp + w.dmg * dmg + w.cs * cs + w.vis * vis;
}

/**
 * Grade every row against the field.
 *
 * Three things go in. How well the player did their role, as a standard score across
 * the ten on the map, which is most of it. Whether their team won, because a game is
 * played to be won and a grade that ignored it read as noise: winners used to take a D
 * as often as an S+. And, against both, what the card was expected to do — the better
 * card has to do more for the same letter, so a 70-rated support who held a game
 * together can still out-grade the 90 beside them.
 */
function gradeRows(rows, minutes, winner) {
  const g = BALANCE.gradeWeights;
  const perf = rows.map((r) => performance(r, minutes));
  const ratings = rows.map((r) => r.effRating);

  return rows.map((r, i) => {
    const score = g.performance * zScore(perf[i], perf)
      + (winner ? (r.team === winner ? g.result : -g.result) : 0)
      - g.expectation * zScore(r.effRating, ratings);
    return { ...r, grade: gradeFor(score, BALANCE.grades) };
  });
}

/** docs/04 section 2: a sample a minute, for the replay's gold sparkline. */
export function sampleTimeline(state) {
  const { BLUE, RED } = state.sides;
  const structures = (side) =>
    ['TOP', 'MID', 'BOT'].reduce(
      (n, lane) => n + side.structures[lane].towers + (side.structures[lane].inhibitor ? 1 : 0),
      0,
    ) + side.structures.nexusTurrets;

  state.timeline.push({
    t: state.t,
    goldDiff: Math.round(teamGold(BLUE) - teamGold(RED)),
    // No XP ledger in the engine: experience tracks gold closely enough that a second
    // one would be two numbers saying the same thing with more ways to disagree.
    xpDiff: Math.round((teamGold(BLUE) - teamGold(RED)) * 0.72),
    structures: { blue: structures(BLUE), red: structures(RED) },
    kills: {
      blue: BLUE.players.reduce((n, p) => n + p.kills, 0),
      red: RED.players.reduce((n, p) => n + p.kills, 0),
    },
  });
}
