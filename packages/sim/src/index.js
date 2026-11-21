/**
 * @lom/sim — simulate(input) -> SimResult.
 *
 * docs/04. Pure, deterministic, no I/O, no clock, no Math.random: the same input and
 * the same seed produce the same event log on a server, in a test and in the tuning
 * harness. That is what makes a replay a record rather than a re-enactment.
 *
 * The loop is deliberately boring. Every tick does the same six things in the same
 * order, and all of the interesting behaviour lives in the modules it calls, so the
 * order of random draws — which is the whole of determinism — is readable in one
 * screen.
 */

import { BALANCE, RULES, SIM_VERSION, phaseAt } from './balance.js';
import { createRng } from './rng.js';
import { buildState } from './state.js';
import { advanceEconomy, teamGold } from './economy.js';
import { resolveLanePhase } from './lane.js';
import { scheduleObjectives, resolveScheduledObjectives } from './objectives.js';
import { rollSkirmish, runTeamfight, respawnPlayers, aliveOf } from './combat.js';
import { resolveSieges } from './structures.js';
import { buildBoxScore, sampleTimeline } from './boxscore.js';
import { regionFor, jitter } from './map.js';

export { configureChampionData } from './champions.js';
export { BALANCE, RULES, SIM_VERSION } from './balance.js';
export { effRating, masteryFactor, roleFit, rarityForOvr, gradeFor } from '../../core/src/index.js';

/**
 * `opts` is a test seam and nothing else: `opts.saySeed` reseeds the commentary stream,
 * which is how the tests prove that the words cannot move the match.
 */
export function simulate(input, opts = {}) {
  const seed = String(input.seed ?? 'lom');
  const rng = createRng(seed);
  const state = buildState({ ...input, rules: input.rules || RULES.modern }, rng, {
    fx: createRng(`${seed}::fx`),
    say: createRng(opts.saySeed ?? `${seed}::say`),
  });

  scheduleObjectives(state);
  state.emit('GAME_START', { t: 0 });
  sampleTimeline(state);

  let nextSample = 60;

  for (state.t = 0; state.t <= BALANCE.maxGameLength; state.t += BALANCE.tick) {
    respawnPlayers(state);
    advanceEconomy(state);

    resolveLanePhase(state);
    if (state.winner) break;

    resolveScheduledObjectives(state);
    if (state.winner) break;

    rollSkirmish(state);
    if (state.winner) break;

    rollLateTeamfight(state);
    resolveSieges(state);
    if (state.winner) break;

    decayMomentum(state);

    if (state.t >= nextSample) {
      sampleTimeline(state);
      nextSample += 60;
    }
  }

  if (!state.winner) suddenDeath(state);

  state.emit('GAME_END', { team: state.winner, t: state.t });
  sampleTimeline(state);

  return {
    simVersion: SIM_VERSION,
    winner: state.winner,
    gameLength: Math.round(state.t),
    endReason: state.endReason,
    events: state.events,
    boxScore: buildBoxScore(state),
    timeline: state.timeline,
    composition: {
      blue: state.sides.BLUE.comp,
      red: state.sides.RED.comp,
    },
  };
}

/**
 * Late games produce fights nobody scheduled — two teams standing in mid eventually
 * do something. Without this the late game is only ever decided at an objective.
 */
function rollLateTeamfight(state) {
  const phase = phaseAt(state.t);
  const rate = BALANCE.teamfightRate[phase];
  if (!rate || !state.rng.chance(rate)) return;

  const { BLUE, RED } = state.sides;
  if (aliveOf(BLUE).length < 3 || aliveOf(RED).length < 3) return;

  // The team that feels ahead starts it, which is both realistic and the reason
  // momentum exists at all.
  const attacker = BLUE.momentum >= RED.momentum ? BLUE : RED;
  const region = regionFor(state.rng, phase);

  runTeamfight(state, attacker, state.opponent(attacker), {
    pos: jitter(state.fx, region),
    region: region.name,
    highStakes: isGameEnding(state),
  });
}

/** docs/04 section 5.4: clutch applies when the fight could end the game. */
function isGameEnding(state) {
  const { BLUE, RED } = state.sides;
  const exposed = (side) =>
    ['TOP', 'MID', 'BOT'].some((lane) => !side.structures[lane].inhibitor);
  const goldGap = Math.abs(teamGold(BLUE) - teamGold(RED));
  return exposed(BLUE) || exposed(RED) || goldGap > BALANCE.clutch.behindGold;
}

function decayMomentum(state) {
  for (const side of [state.sides.BLUE, state.sides.RED]) {
    side.momentum *= 1 - BALANCE.momentum.decay;
  }
}

/**
 * The hard stop (docs/04 section 6.5). Expected in well under 1% of games — if the
 * balance harness reports more, siege conversion is mistuned and this is the symptom,
 * not the problem.
 */
function suddenDeath(state) {
  const { BLUE, RED } = state.sides;
  const standing = (side) =>
    ['TOP', 'MID', 'BOT'].reduce(
      (n, lane) => n + side.structures[lane].towers + (side.structures[lane].inhibitor ? 1 : 0),
      0,
    ) + side.structures.nexusTurrets;

  const blueScore = standing(RED) * -1 + standing(BLUE) + (teamGold(BLUE) - teamGold(RED)) / 1000;
  state.t = BALANCE.maxGameLength;
  state.winner = blueScore >= 0 ? 'BLUE' : 'RED';
  state.endReason = 'SUDDEN_DEATH';
  state.emit('SUDDEN_DEATH', { team: state.winner, t: state.t });
}
