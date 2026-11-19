/**
 * Fights: who dies, who gets the kill, and what it opens up.
 *
 * docs/04 sections 6.3 and 6.4. The rule that matters here is that a fight resolves
 * to a *margin*, not to a binary — a fight won on the edge costs the winner two or
 * three bodies and buys nothing, and that is where most games are actually decided.
 */

import { BALANCE, phaseAt } from './balance.js';
import { playerPower, contestPower, resolve } from './power.js';
import { awardKill, awardTeam, respawnTime } from './economy.js';
import { jitter, regionFor, LANE_ANCHOR } from './map.js';

export const aliveOf = (side) => side.players.filter((p) => p.alive);

export const meanConsistency = (state) =>
  state.players.reduce((n, p) => n + (p.subStats?.consistency ?? 60), 0) / state.players.length;

/**
 * Hand out `count` deaths on `side`, with kills credited to the other team.
 *
 * Victims are drawn by inverse power weighting (docs/04 section 6.4), so the weakest
 * link dies most often. That is deliberately the most legible feedback in the whole
 * engine: a manager who sees their 68-rated top laner with eight deaths knows exactly
 * what to fix, and no other screen tells them that.
 */
export function assignDeaths(state, side, count, phase, pos, only = null) {
  // `only` is the group that was actually in the fight. Without it a gank in top
  // lane could kill the support standing in the bottom side of the map, which is
  // both absurd and the reason the "best player dies less" target was unreachable:
  // deaths were being spread over players who were never there.
  const victims = only ? only.filter((p) => p.alive && p.team === side.name) : aliveOf(side);
  if (!victims.length || count <= 0) return [];

  const enemy = aliveOf(state.opponent(side));
  const taken = [];

  for (let i = 0; i < Math.min(count, victims.length); i++) {
    const pool = victims.filter((p) => p.alive);
    if (!pool.length) break;

    // docs/04 section 6.4 wants the weakest link to die most often, and section 9
    // puts a number on it: the best player should take at most 60% of the worst
    // player's deaths. Straight 1/power cannot reach that — a six-point rating gap
    // is only an eight-percent power gap — so the bias is exponential in the
    // deviation from the group's mean power, with the steepness in BALANCE.
    const powers = pool.map((p) => playerPower(p, phase, state.t));
    const meanPower = powers.reduce((n, v) => n + v, 0) / powers.length || 1;
    const weights = powers.map((v) => Math.exp(-BALANCE.fight.deathBias * (v / meanPower - 1)));
    const victim = pool[state.rng.weighted(weights)];

    const killers = enemy.filter((p) => p.alive);
    const killer = killers.length
      ? killers[state.rng.weighted(killers.map((p) => playerPower(p, phase, state.t)))]
      : null;

    const assists = killers
      .filter((p) => p !== killer)
      .slice(0, state.rng.int(0, 2));

    if (killer) {
      awardKill(killer, victim, assists, state.t);
      killer.damage += 100 + state.rng.int(0, 60);

      const type = state.firstBlood ? 'KILL' : 'FIRST_BLOOD';
      if (!state.firstBlood) {
        awardTeam(state.sides[killer.team], BALANCE.economy.firstBloodTeam);
        // And the lane feels it. Gold alone never moved the first-blood win rate off
        // 50%: a lead has to turn into map pressure to still exist at 30 minutes.
        if (state.lanePressure) {
          const towards = killer.team === 'BLUE' ? 1 : -1;
          const lane = victim.slot === 'TOP' ? 'TOP' : victim.slot === 'MID' ? 'MID' : 'BOT';
          state.lanePressure[lane] += towards * BALANCE.lane.gankPressure;
        }
      }
      state.firstBlood = true;

      state.emit(type, {
        team: killer.team,
        killer: killer.name,
        victim: victim.name,
        actors: { killer: killer.pid, victim: victim.pid, assists: assists.map((a) => a.pid) },
        pos: jitter(state.rng, pos || LANE_ANCHOR[victim.team][victim.slot], 500),
      });
    } else {
      victim.alive = false;
      victim.deaths += 1;
      victim.respawnAt = state.t + respawnTime(state.t);
    }

    taken.push(victim);
  }

  return taken;
}

/** docs/04 section 6.4: an ace buys exactly as long as the bodies stay down. */
function checkAce(state, side, pos) {
  if (aliveOf(side).length) return;

  const enemy = state.opponent(side);
  const window = side.players.reduce((n, p) => n + Math.max(0, p.respawnAt - state.t), 0) / 5;

  state.emit('ACE', { team: enemy.name, pos });
  enemy.pushOpportunity += window * BALANCE.siege.aceBonus;
}

const bumpMomentum = (winner, loser) => {
  winner.momentum = Math.min(1, winner.momentum + BALANCE.momentum.gain);
  loser.momentum = Math.max(-1, loser.momentum - BALANCE.momentum.gain);
};

/**
 * A full fight. `scale` lets a skirmish use the same resolution with fewer bodies on
 * the line, which keeps one code path for "people died in a fight".
 */
export function resolveFight(state, attacker, defender, opts = {}) {
  const phase = phaseAt(state.t);
  const kind = opts.kind || 'TEAMFIGHT';
  const scale = opts.scale ?? 1;
  const pos = opts.pos;

  const attackers = opts.attackers || aliveOf(attacker);
  const defenders = opts.defenders || aliveOf(defender);
  if (!attackers.length || !defenders.length) return null;

  const highStakes = Boolean(opts.highStakes);

  const a = contestPower(attacker, kind, phase, attackers, state.t, { highStakes });
  const d = contestPower(defender, kind, phase, defenders, state.t, {
    highStakes,
    defenderBonus: opts.defenderBonus,
  });

  const outcome = resolve(state.rng, a, d, meanConsistency(state));
  const winner = outcome.won ? attacker : defender;
  const loser = outcome.won ? defender : attacker;
  const margin = Math.abs(outcome.margin);

  const { loserBase, loserMargin, winnerBase, winnerMargin } = BALANCE.fight;
  const loserDeaths = Math.round(
    Math.max(0, Math.min(5, (loserBase + loserMargin * margin + state.rng.float()) * scale)),
  );
  const winnerDeaths = Math.round(
    Math.max(0, Math.min(4, (winnerBase - winnerMargin * margin + state.rng.float()) * scale)),
  );

  const inFight = [...attackers, ...defenders];
  assignDeaths(state, loser, loserDeaths, phase, pos, inFight);
  assignDeaths(state, winner, winnerDeaths, phase, pos, inFight);

  bumpMomentum(winner, loser);

  // A won fight is only worth what it buys. Bodies on the floor, net of your own,
  // are the currency: this is the line that turns kills into structures and so into
  // a finite game, and `BALANCE.siege.secondsPerStructure` is its exchange rate.
  const netBodies = (outcome.won ? loserDeaths : winnerDeaths) - (outcome.won ? winnerDeaths : loserDeaths);
  if (netBodies > 0) {
    winner.pushOpportunity += netBodies * respawnTime(state.t) * BALANCE.siege.bodyValue;
  }

  checkAce(state, loser, pos);
  checkAce(state, winner, pos);

  return { winner, loser, margin: outcome.margin, pWin: outcome.pWin, loserDeaths, winnerDeaths };
}

/** docs/04 section 6.3. Two or three bodies a side, somewhere the phase makes sense. */
export function rollSkirmish(state) {
  const phase = phaseAt(state.t);
  const { BLUE, RED } = state.sides;

  const strategyMod = Math.max(
    BALANCE.strategy[BLUE.strategy]?.skirmishRate ?? 1,
    BALANCE.strategy[RED.strategy]?.skirmishRate ?? 1,
  );
  const momentumDiff = Math.abs(BLUE.momentum - RED.momentum);
  const p = BALANCE.skirmishRate[phase] * strategyMod * (1 + 0.3 * momentumDiff);

  if (!state.rng.chance(p)) return null;

  const region = regionFor(state.rng, phase);
  const pos = jitter(state.rng, region);

  // docs/04 section 6.3: the two or three players *nearest* the region. Taking the
  // first few of the array instead meant top, jungle and mid fought every skirmish
  // in the game while the bot lane watched — which skewed who died, who got first
  // blood, and every stat downstream of both.
  const take = (side) => {
    const alive = aliveOf(side);
    const count = Math.min(alive.length, state.rng.int(2, 3));
    const distance = (p) => {
      const anchor = LANE_ANCHOR[side.name][p.slot];
      return (anchor.x - region.x) ** 2 + (anchor.y - region.y) ** 2;
    };
    return [...alive].sort((a, b) => distance(a) - distance(b)).slice(0, count);
  };

  const attackers = take(BLUE);
  const defenders = take(RED);
  if (!attackers.length || !defenders.length) return null;

  const result = resolveFight(state, BLUE, RED, {
    kind: 'SKIRMISH',
    scale: BALANCE.fight.skirmishScale,
    attackers,
    defenders,
    pos,
  });
  if (!result) return null;

  pushLane(state, result.winner, region.name);

  state.emit('SKIRMISH', {
    team: result.winner.name,
    margin: Math.abs(result.margin),
    region: region.name.toLowerCase().replace('_', ' '),
    pos,
    actors: { participants: [...attackers, ...defenders].map((p2) => p2.pid) },
  });

  // docs/04 section 6.4: a skirmish with bodies left on both sides can turn into the
  // real thing, which is how most unscheduled teamfights start.
  if (
    aliveOf(BLUE).length >= 4
    && aliveOf(RED).length >= 4
    && state.rng.chance(BALANCE.escalation)
  ) {
    runTeamfight(state, result.winner, state.opponent(result.winner), { pos, region: region.name });
  }

  return result;
}

/**
 * An early fight next to a lane is a lane event too: the winners push the wave and
 * take the plate. Without this, nothing that happens before 14:00 leaves a mark, and
 * first blood predicts nothing — which the balance matrix reports as a 50% win rate
 * for the team that drew it.
 */
function pushLane(state, side, regionName) {
  if (state.t >= BALANCE.phases.early || !state.lanePressure) return;
  const lane = regionName.startsWith('TOP') ? 'TOP' : regionName.startsWith('BOT') ? 'BOT' : 'MID';
  const towards = side.name === 'BLUE' ? 1 : -1;
  state.lanePressure[lane] += towards * BALANCE.lane.fightPressure;
}

/** A named teamfight, with the start/end pair the replay ticker reads. */
export function runTeamfight(state, attacker, defender, opts = {}) {
  const region = (opts.region || 'MID_LANE').toLowerCase().replace('_', ' ');
  state.emit('TEAMFIGHT_START', { team: attacker.name, region, pos: opts.pos });

  const result = resolveFight(state, attacker, defender, {
    kind: 'TEAMFIGHT',
    pos: opts.pos,
    highStakes: opts.highStakes,
  });

  if (result) {
    state.emit('TEAMFIGHT_END', {
      team: result.winner.name,
      margin: result.margin,
      pos: opts.pos,
      payload: { pWin: Number(result.pWin.toFixed(3)) },
    });
  }

  return result;
}

/** Bodies come back. Nothing else in the loop may flip `alive` to true. */
export function respawnPlayers(state) {
  for (const p of state.players) {
    if (!p.alive && state.t >= p.respawnAt) p.alive = true;
  }
}
