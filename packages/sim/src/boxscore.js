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
        cs: creepScore(p, state.t),
        gold: Math.round(p.gold),
        damage,
        damageShare: Number((damage / damageTotal).toFixed(3)),
        goldShare: Number((p.gold / gold).toFixed(3)),
        vision: visionFor(p, minutes),
        killParticipation: teamKills ? Number(((p.kills + p.assists) / teamKills).toFixed(3)) : 0,
        effRating: p.effRating,
      });
    }
  }

  return gradeRows(rows);
}

/**
 * Grade every row against the field.
 *
 * Both sides of the comparison are standard scores across the ten players on the map:
 * what the card was worth going in, and what it produced coming out. The difference
 * is the whole grade, and it means a stomp does not hand S grades to the winners for
 * turning up.
 */
function gradeRows(rows) {
  const ratings = rows.map((r) => r.effRating);

  const composite = (r) => {
    const kda = (r.kills + r.assists * 0.6) / Math.max(1, r.deaths);
    return kda * 1.0 + r.damageShare * 6 + r.killParticipation * 2.5 + (r.vision / 100) * 0.6;
  };

  const composites = rows.map(composite);
  const deltas = rows.map((r, i) => zScore(composites[i], composites) - zScore(r.effRating, ratings));
  const spread = deltas.map((d) => d);

  return rows.map((r, i) => ({
    ...r,
    grade: gradeFor(zScore(deltas[i], spread) * 0.9 + deltas[i] * 0.1, BALANCE.grades),
  }));
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
