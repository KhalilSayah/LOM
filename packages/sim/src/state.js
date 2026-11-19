/**
 * buildState(): everything the tick loop needs, resolved once.
 *
 * docs/04 section 3. Composition modifiers, clutch, starting economy and the
 * structure tree are all computed here so the loop itself only ever reads.
 */

import { BALANCE, RULES } from './balance.js';
import { compositionFor } from './champions.js';
import { clutchOf } from './power.js';
import { narrate } from './narration.js';

const SIDES = ['BLUE', 'RED'];
const LANES = ['TOP', 'MID', 'BOT'];

/** Structures fall outside in: three turrets, then the inhibitor (docs/04 6.5). */
const freshLane = () => ({ towers: 3, inhibitor: true, plates: 0 });

export function buildState(input, rng) {
  const rules = input.rules || RULES.modern;

  const all = [];
  const sides = {};

  for (const name of SIDES) {
    const team = input[name.toLowerCase()];
    const players = team.players.map((p, i) => ({
      pid: `${name[0]}${i + 1}`,
      team: name,
      cardKey: p.cardKey,
      name: p.name || p.cardKey,
      slot: p.slot,
      champion: p.champion,
      effRating: p.effRating,
      chemistry: p.chemistry || 0,
      subStats: p.subStats || {},
      gold: 500,
      kills: 0,
      deaths: 0,
      assists: 0,
      damage: 0,
      vision: 0,
      alive: true,
      respawnAt: 0,
      clutch: 0,
    }));

    all.push(...players);

    sides[name] = {
      name,
      managerId: team.managerId,
      strategy: team.strategy || 'STANDARD',
      coach: team.coach || null,
      players,
      // A test seam, and only that: the balance matrix has to measure what a draft
      // edge is worth with everything else held equal, which means setting the comp
      // modifier directly rather than hunting for five champions that produce it.
      comp: team.compModifier
        ? { modifier: team.compModifier, factors: [{ name: 'Fixed', value: 0 }] }
        : compositionFor(players, BALANCE.comp),
      momentum: 0,
      dragons: 0,
      soul: false,
      elderUntil: 0,
      baronUntil: 0,
      heraldsBanked: 0,
      structures: {
        TOP: freshLane(),
        MID: freshLane(),
        BOT: freshLane(),
        nexusTurrets: 2,
        nexus: true,
      },
      pushOpportunity: 0,
      /** Every live power buff this side is carrying, as one multiplier-minus-one. */
      buffs() {
        let n = this.dragons * BALANCE.dragonStack;
        if (this.soul) n += BALANCE.soulPower;
        if (this.elderUntil > this.clock()) n += BALANCE.elderPower;
        if (this.baronUntil > this.clock()) n += BALANCE.baronPower;
        return n;
      },
      clock: () => 0,
    };
  }

  // Clutch is relative to the ten players on the map, so it measures who rises in
  // this match rather than who is good in the abstract.
  for (const p of all) p.clutch = clutchOf(p, all);

  const state = {
    rng,
    rules,
    t: 0,
    seq: 0,
    sides,
    players: all,
    events: [],
    timeline: [],
    winner: null,
    endReason: null,
    firstBlood: false,
    nextObjective: {},
  };

  for (const name of SIDES) sides[name].clock = () => state.t;

  state.opponent = (side) => sides[side.name === 'BLUE' ? 'RED' : 'BLUE'];

  /** Append an event with pre-rendered commentary (docs/04 section 8). */
  state.emit = (type, ctx = {}) => {
    // Sub-tick jitter keeps the replay from looking metronomic (docs/04 section 3),
    // but `t` must be non-decreasing or the ticker plays events out of order and the
    // invariant tests fail. Within a tick, order of emission wins over jitter.
    const jittered = Math.round(ctx.t ?? state.t + rng.int(0, BALANCE.tick - 1));
    const last = state.events.length ? state.events[state.events.length - 1].t : 0;

    const event = {
      // A tick's worth of events that all resolve at one scheduled moment — an
      // objective and the fight over it — would otherwise print the same timestamp
      // eight times. Nudging each one a second past the last keeps the order honest
      // and the play-by-play readable.
      t: Math.max(last + (state.events.length ? 1 : 0), jittered),
      seq: state.seq++,
      type,
      ...(ctx.team ? { team: ctx.team } : {}),
      ...(ctx.actors ? { actors: ctx.actors } : {}),
      ...(ctx.pos ? { pos: ctx.pos } : {}),
      ...(ctx.payload ? { payload: ctx.payload } : {}),
      narration: narrate(rng, type, ctx),
    };
    state.events.push(event);
    return event;
  };

  return state;
}

export { SIDES, LANES };
