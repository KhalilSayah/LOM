/**
 * Scheduled objectives and the contest windows around them.
 *
 * docs/04 section 6.1. Timings come from the `RulesPreset`, never from constants in
 * here, so a league could one day play an older era's map without the engine knowing
 * anything about it.
 *
 * The three-step window is what makes objectives feel like objectives: somebody wins
 * the *setup* — vision and macro, before a single fight — and only then does the pit
 * either go down quietly or turn into the fight of the game.
 */

import { BALANCE, phaseAt } from './balance.js';
import { contestPower, resolve } from './power.js';
import { aliveOf, meanConsistency, runTeamfight } from './combat.js';
import { awardTeam } from './economy.js';
import { takeStructures } from './structures.js';
import { OBJECTIVE_POS, jitter } from './map.js';

/** First spawns, read off the rules preset. */
export function scheduleObjectives(state) {
  const { rules } = state;
  state.nextObjective = {
    SCUTTLE: rules.scuttle.first,
    DRAGON: rules.dragon.first,
    HERALD: rules.herald.first,
    BARON: rules.baron.first,
    ELDER: null,
  };
}

const ORDER = ['DRAGON', 'BARON', 'HERALD', 'ELDER', 'SCUTTLE'];

export function resolveScheduledObjectives(state) {
  for (const kind of ORDER) {
    const spawn = state.nextObjective[kind];
    if (spawn == null) continue;
    // Resolved in the tick the objective spawns in. It used to be decided up to the
    // contest window (45 s) early and stamped at the spawn, so the award landed in the
    // future and dragged every later event in the tick forward with it — and the
    // deaths in the fight over it ended, on the replay, before they had begun.
    if (state.t + BALANCE.tick <= spawn) continue;

    contestObjective(state, kind, spawn);
    if (state.winner) return;
  }
}

function contestObjective(state, kind, spawn) {
  const phase = phaseAt(state.t);
  const { BLUE, RED } = state.sides;
  const pos = jitter(state.fx, OBJECTIVE_POS[kind] || OBJECTIVE_POS.DRAGON, 400);

  const blue = aliveOf(BLUE);
  const red = aliveOf(RED);
  if (!blue.length || !red.length) {
    // One side is wiped: the objective is simply taken, which is exactly why an ace
    // before a baron spawn is worth so much.
    const side = blue.length ? BLUE : RED;
    award(state, side, kind, spawn, pos, { takers: aliveOf(side), free: true });
    return;
  }

  const setup = resolve(
    state.rng,
    contestPower(BLUE, 'OBJECTIVE_SETUP', phase, blue, state.t),
    contestPower(RED, 'OBJECTIVE_SETUP', phase, red, state.t),
    meanConsistency(state),
  );

  const committing = setup.won ? BLUE : RED;
  const other = state.opponent(committing);
  const setupMargin = Math.abs(setup.margin);

  state.emit('SETUP_WON', {
    team: committing.name,
    objective: kind,
    t: state.t,
    payload: { objective: kind },
  });

  // docs/04 section 6.1: a good setup means you often do not have to fight for it.
  const uncontested = BALANCE.objective.uncontested + BALANCE.objective.setupSlope * setupMargin;

  if (state.rng.chance(uncontested)) {
    award(state, committing, kind, spawn, pos, { takers: takersFor(committing, kind, state.t) });
    return;
  }

  const highStakes = kind === 'BARON'
    ? state.t >= BALANCE.clutch.baronAfter
    : kind === 'ELDER';

  const fight = runTeamfight(state, committing, other, {
    pos,
    region: kind === 'BARON' || kind === 'HERALD' ? 'BARON_PIT' : 'DRAGON_PIT',
    objective: kind,
    highStakes,
  });

  const taker = fight ? fight.winner : committing;

  // The steal. The side that won the fight starts the objective, and the other
  // jungler, if still standing, can take it out from under them with a smite.
  if (fight && taker === committing && STEALABLE.has(kind)) {
    const jungler = other.players.find((p) => p.slot === 'JNG' && p.alive);
    if (jungler && state.rng.chance(BALANCE.objective.steal)) {
      award(state, other, kind, spawn, pos, { takers: [jungler], stolen: jungler, contested: true });
      return;
    }
  }

  award(state, taker, kind, spawn, pos, { takers: aliveOf(taker), contested: Boolean(fight) });
}

const STEALABLE = new Set(['DRAGON', 'BARON', 'ELDER']);

/** Who goes for an objective nobody contests: the people a real team would send. */
const SENT = {
  SCUTTLE: ['JNG'],
  DRAGON: ['JNG', 'BOT', 'SUP', 'MID'],
  HERALD: ['JNG', 'TOP', 'MID'],
};

function takersFor(side, kind, t) {
  const alive = aliveOf(side);
  const slots = SENT[kind];
  if (!slots || (kind !== 'SCUTTLE' && t >= BALANCE.phases.early)) return alive;
  const sent = alive.filter((p) => slots.includes(p.slot));
  return sent.length ? sent : alive;
}

function award(state, side, kind, spawn, pos, opts = {}) {
  const { rules } = state;
  const t = spawn;
  const takers = (opts.takers || aliveOf(side)).filter(Boolean);
  const jungler = side.players.find((p) => p.slot === 'JNG');
  // What every objective event carries: who took it, so the dots on the map go there,
  // and who smote it away, when it was stolen.
  const common = {
    team: side.name,
    pos,
    t,
    stolen: Boolean(opts.stolen),
    stealer: opts.stolen?.name,
    contested: Boolean(opts.contested),
    free: Boolean(opts.free),
    jungler: jungler?.name,
    actors: {
      participants: takers.map((p) => p.pid),
      ...(opts.stolen ? { killer: opts.stolen.pid } : {}),
    },
    ...(opts.stolen ? { payload: { stolen: true } } : {}),
  };

  switch (kind) {
    case 'SCUTTLE':
      awardTeam(side, 40);
      state.emit('SCUTTLE', common);
      state.nextObjective.SCUTTLE = spawn + rules.scuttle.respawn < BALANCE.phases.mid
        ? spawn + rules.scuttle.respawn
        : null;
      break;

    case 'DRAGON': {
      side.dragons += 1;
      awardTeam(side, BALANCE.economy.dragonTeam);
      state.emit('DRAGON', {
        ...common,
        count: side.dragons,
        soulPoint: side.dragons === rules.dragon.soulAt - 1,
        payload: { ...(common.payload || {}), count: side.dragons },
      });

      if (side.dragons >= rules.dragon.soulAt && !side.soul) {
        side.soul = true;
        state.emit('SOUL', { team: side.name, pos, t: t + 2, actors: common.actors });
        // Soul closes the dragon cycle and opens elder (docs/04 6.1).
        state.nextObjective.DRAGON = null;
        if (rules.elder.afterSoul) state.nextObjective.ELDER = t + rules.elder.respawn;
      } else {
        state.nextObjective.DRAGON = spawn + rules.dragon.respawn;
      }
      break;
    }

    case 'ELDER':
      side.elderUntil = t + rules.elder.duration;
      state.emit('ELDER', common);
      state.nextObjective.ELDER = t + rules.elder.respawn;
      break;

    case 'HERALD': {
      awardTeam(side, BALANCE.economy.heraldTeam);
      state.emit('HERALD', common);
      // The herald is a structure, not a buff: it cashes out as a turret.
      takeStructures(state, side, 1, { herald: true, takers });
      const next = spawn + rules.herald.respawn;
      state.nextObjective.HERALD = next <= rules.herald.lastSpawn ? next : null;
      break;
    }

    case 'BARON':
      side.baronUntil = t + rules.baron.duration;
      awardTeam(side, BALANCE.economy.baronTeam);
      state.emit('BARON', common);
      // Baron is a siege, not a stat line: the window is what it buys.
      side.pushOpportunity += rules.baron.duration * 0.5;
      state.nextObjective.BARON = spawn + rules.baron.respawn;
      break;

    default:
      break;
  }
}
