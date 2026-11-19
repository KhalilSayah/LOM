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
    if (state.t + state.rules.contestWindow < spawn) continue;

    contestObjective(state, kind, spawn);
    if (state.winner) return;
  }
}

function contestObjective(state, kind, spawn) {
  const phase = phaseAt(state.t);
  const { BLUE, RED } = state.sides;
  const pos = jitter(state.rng, OBJECTIVE_POS[kind] || OBJECTIVE_POS.DRAGON, 400);

  const blue = aliveOf(BLUE);
  const red = aliveOf(RED);
  if (!blue.length || !red.length) {
    // One side is wiped: the objective is simply taken, which is exactly why an ace
    // before a baron spawn is worth so much.
    const side = blue.length ? BLUE : RED;
    award(state, side, kind, spawn, pos);
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

  state.emit('SETUP_WON', { team: committing.name, objective: kind, pos, t: spawn - 20 });

  // docs/04 section 6.1: a good setup means you often do not have to fight for it.
  const uncontested = BALANCE.objective.uncontested + BALANCE.objective.setupSlope * setupMargin;

  if (state.rng.chance(uncontested)) {
    award(state, committing, kind, spawn, pos);
    return;
  }

  const highStakes = kind === 'BARON'
    ? state.t >= BALANCE.clutch.baronAfter
    : kind === 'ELDER';

  const fight = runTeamfight(state, committing, other, {
    pos,
    region: kind === 'BARON' || kind === 'HERALD' ? 'BARON_PIT' : 'DRAGON_PIT',
    highStakes,
  });

  award(state, fight ? fight.winner : committing, kind, spawn, pos);
}

function award(state, side, kind, spawn, pos) {
  const { rules } = state;
  const t = spawn;

  switch (kind) {
    case 'SCUTTLE':
      awardTeam(side, 40);
      state.emit('SCUTTLE', { team: side.name, pos, t });
      state.nextObjective.SCUTTLE = spawn + rules.scuttle.respawn < BALANCE.phases.mid
        ? spawn + rules.scuttle.respawn
        : null;
      break;

    case 'DRAGON': {
      side.dragons += 1;
      awardTeam(side, BALANCE.economy.dragonTeam);
      state.emit('DRAGON', { team: side.name, pos, t, count: side.dragons });

      if (side.dragons >= rules.dragon.soulAt && !side.soul) {
        side.soul = true;
        state.emit('SOUL', { team: side.name, pos, t: t + 2 });
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
      state.emit('ELDER', { team: side.name, pos, t });
      state.nextObjective.ELDER = t + rules.elder.respawn;
      break;

    case 'HERALD': {
      awardTeam(side, BALANCE.economy.heraldTeam);
      state.emit('HERALD', { team: side.name, pos, t });
      // The herald is a structure, not a buff: it cashes out as a turret.
      takeStructures(state, side, 1);
      const next = spawn + rules.herald.respawn;
      state.nextObjective.HERALD = next <= rules.herald.lastSpawn ? next : null;
      break;
    }

    case 'BARON':
      side.baronUntil = t + rules.baron.duration;
      awardTeam(side, BALANCE.economy.baronTeam);
      state.emit('BARON', { team: side.name, pos, t });
      // Baron is a siege, not a stat line: the window is what it buys.
      side.pushOpportunity += rules.baron.duration * 0.5;
      state.nextObjective.BARON = spawn + rules.baron.respawn;
      break;

    default:
      break;
  }
}
