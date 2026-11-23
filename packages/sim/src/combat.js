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
 * One fight's bookkeeping: what kind it was, where, and who killed how many. The tally
 * is what turns three kills by one player into a triple kill rather than three lines.
 */
export function newFight(kind, extra = {}) {
  return { kind, kills: new Map(), deaths: { BLUE: 0, RED: 0 }, ...extra };
}

/** Drop the keys that carry nothing, so a stored event stays small. */
const compact = (obj) => {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== false) out[k] = v;
  return out;
};

/**
 * The teammates credited with an assist on one kill.
 *
 * Only the people who were in the fight, and weighted by role: a support or a jungler
 * is in on most of their team's kills, a top laner on far fewer. This used to be the
 * first one or two names in roster order, which handed the top laner every assist in
 * the game and left the support with almost none.
 */
function pickAssists(state, killer, only) {
  const mates = only
    ? only.filter((p) => p.team === killer.team && p !== killer)
    : state.sides[killer.team].players.filter((p) => p.alive && p !== killer);

  const small = mates.length <= 2 ? BALANCE.fight.smallFightAssist : 0;
  return mates.filter((p) =>
    state.rng.chance(Math.min(0.96, (BALANCE.fight.assistChance[p.slot] ?? 0.5) + small)));
}

/**
 * Hand out `count` deaths on `side`, with kills credited to the other team.
 *
 * Victims are drawn by inverse power weighting (docs/04 section 6.4), so the weakest
 * link dies most often. That is deliberately the most legible feedback in the whole
 * engine: a manager who sees their 68-rated top laner with eight deaths knows exactly
 * what to fix, and no other screen tells them that.
 *
 * `only` is everyone who was in the fight, both sides. Victims come from this side of
 * it, killers and assists from the other — never from somebody on the far side of the
 * map, which is who used to be credited whenever they happened to be strongest.
 */
export function assignDeaths(state, side, count, phase, pos, only = null, fight = null) {
  const victims = only ? only.filter((p) => p.alive && p.team === side.name) : aliveOf(side);
  if (!victims.length || count <= 0) return [];

  const enemySide = state.opponent(side);
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

    // The enemies who were in this fight and are still standing. Only if every one of
    // them is down does the kill go to whoever arrives late.
    let killers = only ? only.filter((p) => p.alive && p.team === enemySide.name) : [];
    if (!killers.length) killers = aliveOf(enemySide);
    const killer = killers.length
      ? killers[state.rng.weighted(killers.map((p) => playerPower(p, phase, state.t)))]
      : null;

    if (killer) {
      const assists = pickAssists(state, killer, only);
      const shutdown = victim.streak >= 3 ? victim.streak : 0;

      awardKill(killer, victim, assists, state.t);
      killer.damage += 100 + state.rng.int(0, 60);

      const first = !state.firstBlood;
      if (first) {
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

      if (fight) {
        const tally = fight.kills.get(killer.pid) || { player: killer, count: 0 };
        tally.count += 1;
        fight.kills.set(killer.pid, tally);
        fight.deaths[victim.team] += 1;
      }

      state.emit(first ? 'FIRST_BLOOD' : 'KILL', {
        team: killer.team,
        killer: killer.name,
        victim: victim.name,
        killerSlot: killer.slot,
        victimSlot: victim.slot,
        assistName: assists[0]?.name,
        assistCount: assists.length,
        kind: fight?.kind,
        region: fight?.region,
        lane: fight?.lane,
        turned: Boolean(fight?.failed),
        streak: killer.streak,
        shutdown,
        actors: { killer: killer.pid, victim: victim.pid, assists: assists.map((a) => a.pid) },
        pos: jitter(state.fx, pos || LANE_ANCHOR[victim.team][victim.slot], 500),
        payload: compact({
          // When the sim brings them back, so the replay greys the dot for exactly as
          // long as the engine kept them dead.
          respawnAt: Math.round(victim.respawnAt),
          streak: killer.streak >= 3 ? killer.streak : null,
          shutdown: shutdown || null,
        }),
      });
    } else {
      victim.alive = false;
      victim.deaths += 1;
      victim.streak = 0;
      victim.respawnAt = state.t + respawnTime(state.t);
      if (fight) fight.deaths[victim.team] += 1;
    }

    taken.push(victim);
  }

  return taken;
}

const MULTI = { 2: 'double', 3: 'triple', 4: 'quadra', 5: 'penta' };

/** Double, triple, quadra, penta: one line per player who took more than one. */
export function emitMultikills(state, fight) {
  for (const { player, count } of fight.kills.values()) {
    if (count < 2) continue;
    const n = Math.min(5, count);
    state.emit('MULTIKILL', {
      team: player.team,
      killer: player.name,
      count: n,
      actors: { killer: player.pid },
      payload: { count: n, label: MULTI[n] },
    });
  }
}

/** docs/04 section 6.4: an ace buys exactly as long as the bodies stay down. */
function checkAce(state, side, pos) {
  if (aliveOf(side).length) return false;

  const enemy = state.opponent(side);
  const window = side.players.reduce((n, p) => n + Math.max(0, p.respawnAt - state.t), 0) / 5;

  state.emit('ACE', {
    team: enemy.name,
    pos,
    actors: { participants: aliveOf(enemy).map((p) => p.pid) },
  });
  enemy.pushOpportunity += window * BALANCE.siege.aceBonus;
  return true;
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
  const fight = newFight(kind, { region: opts.region, lane: opts.lane });

  // The winner's losses first, while the whole losing side is still standing to take
  // them, then the collapse. Somebody on the winning side is always left: a fight that
  // kills everyone on both sides has no winner to speak of, and the last kill of it
  // used to go to a player who had not been there.
  const winnersIn = inFight.filter((p) => p.team === winner.name).length;
  const winnerLosses = Math.min(winnerDeaths, Math.max(0, winnersIn - 1));
  assignDeaths(state, winner, winnerLosses, phase, pos, inFight, fight);
  assignDeaths(state, loser, loserDeaths, phase, pos, inFight, fight);
  emitMultikills(state, fight);

  bumpMomentum(winner, loser);

  // A won fight is only worth what it buys. Bodies on the floor, net of your own,
  // are the currency: this is the line that turns kills into structures and so into
  // a finite game, and `BALANCE.siege.secondsPerStructure` is its exchange rate.
  const netBodies = loserDeaths - winnerLosses;
  if (netBodies > 0) {
    winner.pushOpportunity += netBodies * respawnTime(state.t) * BALANCE.siege.bodyValue;
  }

  const aced = checkAce(state, loser, pos);
  checkAce(state, winner, pos);

  return {
    winner,
    loser,
    margin: outcome.margin,
    pWin: outcome.pWin,
    /** The chance the side that won had going in: under a half is an upset. */
    odds: outcome.won ? outcome.pWin : 1 - outcome.pWin,
    loserDeaths: fight.deaths[loser.name],
    winnerDeaths: fight.deaths[winner.name],
    aced,
    fight,
  };
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
  const pos = jitter(state.fx, region);

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
    region: region.name,
  });
  if (!result) return null;

  pushLane(state, result.winner, region.name);

  state.emit('SKIRMISH', {
    team: result.winner.name,
    margin: Math.abs(result.margin),
    region: region.name,
    odds: result.odds,
    wDeaths: result.winnerDeaths,
    lDeaths: result.loserDeaths,
    size: Math.max(attackers.length, defenders.length),
    pos,
    // The ones still standing: the fallen are already on their way back to base.
    actors: { participants: [...attackers, ...defenders].filter((p2) => p2.alive).map((p2) => p2.pid) },
    payload: {
      region: region.name,
      odds: Number(result.odds.toFixed(3)),
      deaths: { winner: result.winnerDeaths, loser: result.loserDeaths },
    },
  });

  // docs/04 section 6.4: a skirmish with bodies left on both sides can turn into the
  // real thing, which is how most unscheduled teamfights start.
  if (
    aliveOf(BLUE).length >= 4
    && aliveOf(RED).length >= 4
    && state.rng.chance(BALANCE.escalation)
  ) {
    runTeamfight(state, result.winner, state.opponent(result.winner), {
      pos,
      region: region.name,
      escalated: true,
    });
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
  const region = opts.region || 'MID_LANE';
  const participants = [...aliveOf(attacker), ...aliveOf(defender)].map((p) => p.pid);

  state.emit('TEAMFIGHT_START', {
    team: attacker.name,
    region,
    objective: opts.objective,
    highStakes: opts.highStakes,
    escalated: opts.escalated,
    late: state.t >= BALANCE.phases.mid,
    pos: opts.pos,
    actors: { participants },
    payload: compact({ region, objective: opts.objective }),
  });

  const result = resolveFight(state, attacker, defender, {
    kind: 'TEAMFIGHT',
    pos: opts.pos,
    region,
    highStakes: opts.highStakes,
  });

  if (result) {
    state.emit('TEAMFIGHT_END', {
      team: result.winner.name,
      margin: result.margin,
      odds: result.odds,
      wDeaths: result.winnerDeaths,
      lDeaths: result.loserDeaths,
      aced: result.aced,
      objective: opts.objective,
      region,
      late: state.t >= BALANCE.phases.mid,
      pos: opts.pos,
      actors: { participants: participants.filter((pid) => state.players.find((p) => p.pid === pid)?.alive) },
      payload: {
        pWin: Number(result.pWin.toFixed(3)),
        odds: Number(result.odds.toFixed(3)),
        region,
        deaths: { winner: result.winnerDeaths, loser: result.loserDeaths },
      },
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
