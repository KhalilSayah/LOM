/**
 * Every tunable number in the engine, in one object (docs/04 R6).
 *
 * The rule this file exists to enforce: no magic numbers anywhere else in the sim. A
 * balance pass is then reading one file and changing one constant at a time, with
 * `npm run sim:balance` as the check — not archaeology through the tick loop.
 *
 * docs/04 section 9 gives the tuning order when a target fails: k and sigma for the
 * win-rate rows, pressureRate and siege conversion for game length, skirmishRate and
 * the teamfight loss curves for kill counts.
 */

/**
 * 1.1.0: fights credit kills and assists to the players who were in them, CS is farmed
 * per role rather than read back out of gold, objectives resolve in the tick they spawn,
 * narration and presentation draw from their own streams, and fights announce their
 * multikills and steals. Results from 1.0.0 still replay: every new field is optional.
 */
export const SIM_VERSION = '1.1.0';

export const BALANCE = {
  /** 15 game-seconds per tick: a 35-minute game is 140 ticks (docs/04 section 3). */
  tick: 15,
  maxGameLength: 55 * 60,

  phases: { early: 14 * 60, mid: 25 * 60 },

  /**
   * The logistic that resolves every contest. k is the slope, sigma the scale of a
   * rating difference. Together they decide how much a better squad is worth, which
   * is the single most load-bearing pair of numbers in the project.
   */
  k: 1.0,
  /**
   * docs/04 section 5.5 prints sigma as 3.6, which cannot be right at the scale the
   * rest of the document uses: contest power is in rating units near 70-90, so a
   * five-point edge would resolve at 77% per contest and compound into a 98% match
   * win rate across twenty fights. The matrix in section 9 wants 56-59% for that
   * same edge, which puts a single contest near 53% — and that is what this value
   * is fitted to. The doc's intent is kept; its arithmetic is not.
   */
  sigma: 98,
  /** docs/04 section 5.5: the underdog always has a story. */
  winFloor: 0.08,
  winCeiling: 0.92,

  /** Consistent teams swing less. Multiplies k, so it flattens the curve, not the mean. */
  consistencyK: { base: 0.75, span: 0.5 },

  momentum: { gain: 0.18, decay: 0.12, weight: 0.05 },

  /** docs/04 section 5.4, applied only when the stakes are high. */
  clutch: { weight: 0.03, baronAfter: 25 * 60, behindGold: 3000 },

  phaseCurve: {
    LANE_BULLY: { EARLY: 1.12, MID: 1.0, LATE: 0.9 },
    SKIRMISHER: { EARLY: 1.06, MID: 1.04, LATE: 0.94 },
    ASSASSIN: { EARLY: 1.0, MID: 1.1, LATE: 0.95 },
    TANK: { EARLY: 0.95, MID: 1.05, LATE: 1.05 },
    UTILITY: { EARLY: 0.98, MID: 1.02, LATE: 1.02 },
    SCALING_CARRY: { EARLY: 0.86, MID: 1.02, LATE: 1.18 },
  },

  /** How hard a gold lead converts into power, by archetype (docs/04 section 5.1). */
  scalingCoef: {
    LANE_BULLY: 1.0,
    SKIRMISHER: 1.05,
    ASSASSIN: 1.2,
    TANK: 0.6,
    UTILITY: 0.7,
    SCALING_CARRY: 1.3,
  },
  goldFactor: { floor: -0.35, ceiling: 0.45 },

  /** Sub-stat emphasis per contest kind (docs/04 section 5.2). */
  contestWeights: {
    LANE: { laning: 1.4 },
    GANK: { mechanics: 1.2, vision: 1.2 },
    SKIRMISH: { mechanics: 1.3 },
    TEAMFIGHT: { teamfight: 1.3 },
    OBJECTIVE_SETUP: { macro: 1.3, vision: 1.2 },
    SIEGE: { macro: 1.2 },
  },

  /** docs/01: three presets, applied to the whole team for the match. */
  strategy: {
    STANDARD: {},
    AGGRESSIVE: {
      skirmishRate: 1.12,
      EARLY: 1.08,
      LATE: 0.94,
      OBJECTIVE_SETUP: 0.9,
    },
    SCALING: {
      EARLY: 0.9,
      LATE: 1.1,
      SIEGE_DEFENCE: 1.15,
    },
  },

  comp: { min: 0.92, max: 1.08 },

  /**
   * How often winning the setup is enough to take the objective without a fight
   * (docs/04 section 6.1). This is the main dial on how many kills a game produces:
   * every contested objective is a teamfight, and a teamfight is three bodies.
   */
  objective: {
    uncontested: 0.88,
    setupSlope: 0.12,
    /**
     * When the side that won the fight at the pit starts the objective, the chance that
     * the other side's jungler, still standing, smites it away from them.
     */
    steal: 0.1,
  },

  /** Lane phase (docs/04 section 6.2). Pressure is in arbitrary units per tick. */
  lane: {
    /**
     * Pressure per tick at full saturation, and the power difference that counts as
     * full (`scale`).
     *
     * Saturating matters more than the rate does. Linear pressure made the lane the
     * dominant channel for a rating edge and one sigma could not touch: a +20 squad
     * took plates four times faster than a +5 squad and the matrix read 84% where it
     * wanted 75%. Lane income in a real game saturates — there are five plates and
     * one outer turret — so a much better laner wins the lane, not twenty lanes.
     */
    pressureRate: 0.95,
    scale: 18,
    plateThreshold: 10,
    plateReset: 0.45,
    towerThreshold: 18,
    gankChance: { base: 0.009, pressure: 0.007, macro: 0.009 },
    /**
     * Pressure a successful gank hands the lane. docs/04 section 9 wants the
     * first-blood team to win 56-62% of games, and that only happens if an early
     * kill turns into something: plates, a turret, and the gold that follows.
     */
    gankPressure: 19,
    /** Pressure an early fight hands the lane it happened next to. */
    fightPressure: 8,
  },

  skirmishRate: { EARLY: 0.028, MID: 0.032, LATE: 0.02 },
  /** A skirmish with bodies on both sides can turn into the real thing. */
  escalation: 0.2,
  /** LATE was 0.075 before objectives resolved at their spawn; see secondsPerStructure. */
  teamfightRate: { EARLY: 0, MID: 0.015, LATE: 0.068 },

  /** docs/04 section 6.4: deaths from a fight, as a function of how lopsided it was. */
  fight: {
    loserBase: 0.9,
    loserMargin: 6,
    /**
     * Lower than the 2.2 in docs/04: at the margins this engine actually produces,
     * 2.2 meant the winner of a close fight lost more people than the loser, which
     * read as nonsense in the play-by-play.
     */
    winnerBase: 1.35,
    winnerMargin: 3,
    skirmishScale: 0.4,
    /**
     * Chance that a teammate who was in the fight is credited with the assist, by role.
     * Supports and junglers are in on almost everything, which is what their kill
     * participation looks like in any real box score.
     */
    assistChance: { TOP: 0.48, JNG: 0.7, MID: 0.56, BOT: 0.56, SUP: 0.84 },
    /** Added to the chance above in a fight of two or three, where nobody is far away. */
    smallFightAssist: 0.18,
    /**
     * Steepness of the inverse-power weighting that decides who dies. 14 until 1.1.0;
     * once kills went to the people in the fight rather than to the strongest player
     * anywhere, the best card stopped being fed by fights it was not in, and the
     * "best player dies less" row needed a steeper curve to hold.
     */
    deathBias: 22,
  },

  /** Seconds of enemy respawn time converted into one structure (docs/04 section 6.5). */
  siege: {
    /**
     * 50 until 1.1.0. Baron and dragons now resolve when they spawn rather than up to
     * 45 seconds early, which added most of a minute to the average game and two kills
     * with it; a slightly cheaper structure takes that minute back.
     */
    secondsPerStructure: 47,
    baron: 1.6,
    elder: 1.35,
    aceBonus: 1.15,
    /** Share of a dead enemy's respawn timer that becomes map pressure. */
    bodyValue: 0.34,
    /**
     * How much a push window varies either side of its nominal value. docs/04
     * section 9 wants a 5-7 minute spread in game length; without this every game
     * converts advantage at exactly the same rate and they all end within a few
     * minutes of each other.
     */
    jitter: 0.55,
  },

  economy: {
    baselineGpm: { TOP: 375, JNG: 360, MID: 395, BOT: 420, SUP: 240 },
    kill: 300,
    /**
     * Paid to the whole team on first blood. docs/04 section 9 wants the first-blood
     * team to win 56-62% of games: the killer's own 300 gold cannot carry that, and
     * in a real game first blood funds an item spike the whole map feels.
     */
    firstBloodTeam: 520,
    assist: 150,
    plate: 175,
    towerTeam: 250,
    towerLocal: 100,
    dragonTeam: 100,
    heraldTeam: 150,
    baronTeam: 300,
    respawn: { base: 8, perMinute: 1.4, min: 8, max: 60 },
    /** Gold per creep, used to back-compute CS for the box score. */
    goldPerCs: 21,
    /**
     * Creeps a minute while alive, by role: minions in lane, camps in the jungle, and
     * almost nothing for a support. Pitched a little above the real per-minute averages
     * because dead time and the first ninety seconds farm nothing.
     */
    csPerMin: { TOP: 8.05, JNG: 6.15, MID: 9.2, BOT: 9.55, SUP: 1.35 },
    /** No minion reaches a lane before this. */
    csFrom: 85,
  },

  /** Each dragon is a small stacking power buff; soul is the big one. */
  dragonStack: 0.012,
  soulPower: 0.05,
  elderPower: 0.08,
  baronPower: 0.06,

  grades: { splus: 1.75, s: 1.1, a: 0.45, b: -0.45, c: -1.1 },
  /** How a grade is made: role performance, the result, and the card's expectation. */
  gradeWeights: { performance: 0.9, result: 0.36, expectation: 0.3 },
};

/**
 * Objective timings are data, not code (docs/04 section 6.1), so a league can one day
 * play under a different era's rules without the engine knowing anything about it.
 */
export const RULES = {
  modern: {
    id: 'modern',
    scuttle: { first: 210, respawn: 150 },
    dragon: { first: 300, respawn: 300, soulAt: 4 },
    elder: { afterSoul: true, respawn: 360, duration: 150 },
    herald: { first: 840, respawn: 360, lastSpawn: 1140 },
    baron: { first: 1200, respawn: 360, duration: 180 },
    plates: { until: 840 },
    /** How long before a spawn the contest window opens. */
    contestWindow: 45,
  },
};

export const phaseAt = (t) =>
  t < BALANCE.phases.early ? 'EARLY' : t < BALANCE.phases.mid ? 'MID' : 'LATE';
