# 04 — Simulation Engine

Package: `packages/sim` (`@lom/sim`). Pure TypeScript, zero dependencies, no I/O, no clock,
no `Math.random`. Runs on the Nitro server, in tests, and in a local tuning harness.

## 1. Requirements

| # | Requirement | Why |
|---|---|---|
| R1 | **Deterministic.** Same input + same seed + same `sim_version` = byte-identical event log. | Replays must be reproducible; disputes must be resolvable |
| R2 | **Fast.** < 50 ms per match, < 5 ms is the target. | 10k-match Monte Carlo balance runs must take seconds |
| R3 | **Legible.** Every event must be explainable in one sentence to a player. | "Why did I lose?" needs an answer better than "RNG" |
| R4 | **Replayable as animation.** Output carries positions and timing, not just a result. | The map replay is the payoff of the whole daily loop |
| R5 | **Versioned.** `sim_version` is stored with every match. | Tuning changes must not corrupt old replays |
| R6 | **Tunable from data.** All constants live in one exported `BALANCE` object. | The balance pass is iteration, not code archaeology |

Explicit **non-requirement**: physical accuracy. This is not a MOBA engine. It is a stochastic
narrative generator constrained by plausible League of Legends structure.

## 2. Interface

```ts
export function simulate(input: SimInput): SimResult;

interface SimInput {
  seed: string;                       // hash(fixture_id)
  rules: RulesPreset;                 // objective timings, see section 6.1
  blue: TeamInput;
  red: TeamInput;
}

interface TeamInput {
  managerId: string;
  strategy: 'STANDARD' | 'AGGRESSIVE' | 'SCALING';
  coach: CoachEffect | null;
  players: [PlayerInput, PlayerInput, PlayerInput, PlayerInput, PlayerInput];
}

interface PlayerInput {
  cardKey: string;
  slot: 'TOP' | 'JNG' | 'MID' | 'BOT' | 'SUP';
  champion: string;                   // from the draft
  effRating: number;                  // precomputed, see 02 section 2.4
  subStats: { laning; teamfight; mechanics; macro; vision; consistency };
  chemistry: number;                  // 0..4.5
}

interface SimResult {
  simVersion: string;
  winner: 'BLUE' | 'RED';
  gameLength: number;                 // seconds
  events: SimEvent[];                 // strictly non-decreasing t
  boxScore: BoxScoreRow[];            // 10 rows
  timeline: TimelineSample[];         // every 60 s: gold diff, xp diff, structures
}
```

Champion static data (class tags, lane affinity) is injected once via
`configureChampionData(table)` so the engine itself holds no asset dependency.

## 3. Architecture

```
simulate()
  |
  +-- buildState()        resolve powers, comp modifiers, starting economy
  +-- tick loop           t = 0 .. maxGameLength, step 15 s
  |     +-- advanceEconomy()
  |     +-- resolveLanePhase()        (t < 14:00)
  |     +-- resolveScheduledObjectives()
  |     +-- rollSkirmishes()
  |     +-- resolveSieges()
  |     +-- checkVictory()
  +-- finalise()          box score, grades, timeline samples
```

A **tick is 15 game-seconds**. A 35-minute game is 140 ticks. Events carry sub-tick timestamps
(`t = tickStart + rng.int(0, 14)`) so the replay does not look metronomic.

### 3.1 Randomness

One PRNG stream, `mulberry32` seeded from `fnv1a(seed)`, consumed in a fixed order. Any new
random draw added to the engine **must** bump `sim_version` because it shifts every later
draw. Helpers: `rng.float()`, `rng.int(a,b)`, `rng.pick(arr)`, `rng.chance(p)`.

## 4. Game phases

| Phase | Window | Character |
|---|---|---|
| `EARLY` | 0:00 - 14:00 | Lane phase. Few 5v5s. Plates, scuttles, early dragons, ganks. |
| `MID` | 14:00 - 25:00 | Grouping, heralds, tower trading, mid-size fights. |
| `LATE` | 25:00+ | Baron/Elder, full teamfights, decisive sieges. |

Phase boundaries are in `BALANCE.phases` and are part of the `RulesPreset`.

## 5. Power model

### 5.1 Player power

```
playerPower(p, phase) =
    (p.effRating + p.chemistry)
  * phaseCurve[classOf(p.champion)][phase]
  * (1 + goldFactor(p))
  * (p.alive ? 1 : 0)
```

`phaseCurve` — champion archetypes derived from Data Dragon tags plus an override table:

| Archetype | EARLY | MID | LATE |
|---|---|---|---|
| `LANE_BULLY` | 1.12 | 1.00 | 0.90 |
| `SKIRMISHER` | 1.06 | 1.04 | 0.94 |
| `ASSASSIN` | 1.00 | 1.10 | 0.95 |
| `TANK` | 0.95 | 1.05 | 1.05 |
| `UTILITY` | 0.98 | 1.02 | 1.02 |
| `SCALING_CARRY` | 0.86 | 1.02 | 1.18 |

```
goldFactor(p) = clamp((p.gold - expectedGold(t, p.slot)) / expectedGold(t, p.slot), -0.35, 0.45)
              * scalingCoef[classOf(p.champion)]       // 0.6 TANK .. 1.3 SCALING_CARRY
```

This is the feedback loop that makes leads real without making them absolute: a fed scaling
carry gets up to +45% power, a fed tank gets much less.

### 5.2 Contest power

Different contests weigh different players and sub-stats.

| Contest | Participants | Sub-stat emphasis |
|---|---|---|
| `LANE` | the 1-2 players in that lane | `laning` x1.4 |
| `GANK` | lane players + both junglers | `mechanics` x1.2, `vision` x1.2 (defender) |
| `SKIRMISH` | 3 nearest players per side | `mechanics` x1.3 |
| `TEAMFIGHT` | all alive players | `teamfight` x1.3, comp modifier applied |
| `OBJECTIVE_SETUP` | all alive players | `macro` x1.3, `vision` x1.2 |
| `SIEGE` | all alive players | `macro` x1.2, defender gets structure bonus |

```
contestPower(team, kind, phase) =
    mean( playerPower(p, phase) * subStatWeight(p, kind) for p in participants )
  * compModifier(team, kind)
  * strategyModifier(team.strategy, kind, phase)
  * coachModifier(team.coach, kind, phase)
```

### 5.3 Composition modifier

Computed once at `buildState()` from champion tags, range **0.92 - 1.08**:

| Factor | Range |
|---|---|
| Frontline/backline balance (ideal 2 front, 3 back) | +/-0.03 |
| Has a hard engage tool | +/-0.02 |
| Has disengage/peel | +/-0.015 |
| AoE damage concentration (good for teamfight, bad for skirmish) | +/-0.02 |
| Damage-type split (full AD or full AP is punished) | +/-0.015 |

The modifier is **shown to the player on the draft screen as it updates**, with the factor
names. That transparency is what turns the draft from guessing into reasoning.

### 5.4 Clutch

Not a sub-stat. A derived modifier applied only when the stakes are high:

```
clutch(p) = 0.5 * z(p.mechanics) + 0.3 * z(p.consistency) + 0.2 * z(p.teamfight)
```

Applied as a `+/-3%` power swing in: baron fights after 25:00, fights while the team is behind
more than 3k gold, and any fight that could end the game. It exists purely so the commentary
line "and that is why you pay him" has something behind it.

### 5.5 Resolution

Every contest resolves through one logistic function:

```
d        = contestPower(attacker) - contestPower(defender)
kEff     = BALANCE.k * (0.75 + 0.5 * meanConsistency / 99)   // consistent teams = less variance
pWin     = 1 / (1 + exp(-kEff * d / BALANCE.sigma))
pWin     = clamp(pWin, 0.08, 0.92)                            // nothing is ever certain
outcome  = rng.chance(pWin)
```

The clamp matters: an 8% floor means the underdog always has a story, and it is what keeps a
stacked collection from producing a 100% season.

**Momentum.** Each team carries `momentum` in `[-1, +1]`, moved `+0.18` on a won teamfight or
objective and decayed 12% per tick toward zero. It adds `momentum * 0.04` to contest power —
small enough to be flavour, large enough to produce comeback narratives.

## 6. Event generation

### 6.1 Scheduled objectives (`RulesPreset`)

Objective timings are **data, not code**, so different "rules eras" can be shipped:

```jsonc
{
  "id": "modern",
  "scuttle":  { "first": 210, "respawn": 150 },
  "dragon":   { "first": 300, "respawn": 300, "soulAt": 4 },
  "elder":    { "afterSoul": true, "respawn": 360, "duration": 150 },
  "herald":   { "first": 840, "respawn": 360, "lastSpawn": 1140 },
  "baron":    { "first": 1200, "respawn": 360, "duration": 180 },
  "plates":   { "until": 840 }
}
```

For each objective, at `spawn - 45 s` the engine opens a **contest window**:

1. Both teams roll `OBJECTIVE_SETUP` to decide who gets to commit (`SETUP_WON` event, vision
   and macro heavy).
2. The committing team either takes it uncontested (`p = 0.55 + 0.35 * setupMargin`) or a
   `TEAMFIGHT` resolves it.
3. Winner takes the objective, loser takes 1-4 deaths from the fight resolution.

### 6.2 Lane phase

Each tick before 14:00, per lane:

```
lanePressure[lane] += (lanePower.blue - lanePower.red) * BALANCE.pressureRate * dt
```

- Crossing `+/- plateThreshold` emits a `PLATE` event and resets the counter partially.
- Crossing `+/- towerThreshold` emits `TOWER` for the outer turret.
- Each tick there is a `gankChance` per lane, scaled by jungler `macro` and the lane's current
  pressure (losing lanes get ganked more, which is correct and feels right).

### 6.3 Skirmishes

```
pSkirmish(tick) = BALANCE.skirmishRate[phase]
                * strategyMod            // AGGRESSIVE +12%
                * (1 + 0.3 * |momentumDiff|)
```

On trigger: pick a map region weighted by phase (jungle early, mid/objectives later), pick 2-3
participants per side nearest that region, resolve `SKIRMISH`, emit `KILL`/`ASSIST`/`DEATH`.

### 6.4 Teamfights

Triggered by objective windows, by a `SKIRMISH` escalating (20% if both sides have 4+ alive),
or randomly in `LATE` at `BALANCE.teamfightRate.LATE`.

Resolution produces a **margin**, not a binary:

```
margin   = pWin - 0.5                                  // -0.5 .. +0.5
losses   = round(clamp(1 + 8 * |margin| + rng.float(), 0, 5))   // deaths on losing side
winLoss  = round(clamp(2.2 - 4 * |margin| + rng.float(), 0, 4)) // deaths on winning side
```

Individual deaths are assigned by inverse `playerPower` weighting, so the weakest link dies
most often — which is exactly the feedback a manager needs to see.

An **ACE** (5 deaths) opens a `pushOpportunity` equal to the sum of the dead team's remaining
respawn timers.

### 6.5 Sieges and victory

```
pushOpportunity (seconds)  ->  structures taken = floor(opportunity / 22)
```

Structures fall in order per lane: outer -> inner -> inhibitor turret -> inhibitor -> nexus
turret -> nexus. Baron buff multiplies conversion by 1.6; Elder by 1.35.

**Victory:** both nexus turrets plus the nexus fall on any lane with a downed inhibitor.
A team that is 5-dead in `LATE` against a baron-buffed opponent with an inhibitor down will
lose; that is the intended shape.

**Hard stop:** `maxGameLength = 55:00`. If reached, the team with the greater
`structureAdvantage + goldDiff/1000` wins by a `SUDDEN_DEATH` event. This should fire in well
under 1% of games; if it fires more often the siege conversion rate is mistuned.

## 7. Economy

| Source | Gold |
|---|---|
| Passive + CS baseline (per minute, by slot) | TOP 375, JNG 360, MID 395, BOT 420, SUP 240 |
| Kill | 300 to the killer |
| Assist | 150 split among assistants |
| Plate | 175 to the local player |
| Tower | 250 split team-wide + 100 to the local player |
| Dragon | 100 team-wide (plus a stacking power buff) |
| Herald | 150 team-wide, plus a free plate/tower conversion |
| Baron | 300 team-wide + the siege multiplier |

```
expectedGold(t, slot) = baselineGpm[slot] * t / 60
respawnTime(t)        = clamp(8 + 1.4 * t / 60, 8, 60)      // seconds
```

CS is back-computed from gold for the box score rather than simulated, which keeps the engine
small and the numbers plausible.

## 8. Event schema

```ts
type SimEvent = {
  t: number;                           // game seconds
  seq: number;                         // tiebreak within a tick
  type: EventType;
  team?: 'BLUE' | 'RED';
  actors?: { killer?: pid; victim?: pid; assists?: pid[]; participants?: pid[] };
  pos?: { x: number; y: number };      // Summoner's Rift coords, 0..14870
  payload?: Record<string, unknown>;
  narration: string;                   // pre-rendered, e.g. "Faker catches Chovy in the river"
};

type EventType =
  | 'GAME_START' | 'FIRST_BLOOD' | 'KILL' | 'MULTIKILL' | 'ACE'
  | 'PLATE' | 'TOWER' | 'INHIBITOR' | 'NEXUS_TURRET' | 'NEXUS'
  | 'DRAGON' | 'SOUL' | 'ELDER' | 'HERALD' | 'BARON' | 'SCUTTLE'
  | 'TEAMFIGHT_START' | 'TEAMFIGHT_END' | 'SKIRMISH' | 'GANK'
  | 'SETUP_WON' | 'RECALL' | 'ROAM' | 'WARD' | 'SUDDEN_DEATH' | 'GAME_END';
```

**Positions matter.** The replay interpolates champion dots between the last two events that
mention them, falling back to a per-slot lane anchor and a phase-dependent grouping anchor.
Writing `pos` on every combat event is what makes the animation readable rather than abstract.
Anchors live in `packages/sim/src/map.ts` alongside the lane paths.

`narration` is generated in the engine (not the client) from a template bank keyed by event
type, margin and player names, so commentary is part of the deterministic output and can be
diffed in golden tests.

## 9. Balance targets and tuning

These are the numbers the Monte Carlo harness checks. They are the actual definition of
"correctly tuned".

| Target | Value | Rationale |
|---|---|---|
| Win rate, equal squads | 50% +/- 1% over 20k sims | No side bias |
| Win rate, +5 mean effRating | 56-59% | A modest edge is an edge, not a verdict |
| Win rate, +10 mean effRating | 62-66% | [00 section 8](00-vision-and-scope.md) criterion 4 |
| Win rate, +20 mean effRating | 72-78% | Stacked squads must still lose a quarter of the time |
| Win rate, draft advantage only (equal ratings, better comp modifier +0.06) | 55-58% | Drafting well is worth about as much as +5 rating |
| Mean game length | 31-34 min | Matches real pro averages closely enough to feel right |
| Game length stddev | 5-7 min | Variety without absurdity |
| Games decided before 20:00 | < 8% | Stomps exist but are rare |
| `SUDDEN_DEATH` rate | < 1% | Otherwise siege conversion is wrong |
| Mean kills per game | 22-30 | Pro-like, not ARAM-like |
| First-blood team win rate | 56-62% | Early leads matter, do not decide |
| Mean deaths, best player on a team | <= 60% of the worst player's | Power weighting is working |

**Harness:** `pnpm sim:balance` runs the matrix and prints a pass/fail table. It is a CI gate.
Any change to `BALANCE` or to the engine must leave every row green.

**Tuning order** when a row fails: `BALANCE.k` and `sigma` for win-rate rows, `pressureRate`
and siege conversion for game-length rows, `skirmishRate` and teamfight loss curves for kill
counts. Change one constant at a time; the harness is cheap.

## 10. Box score and grades

Per player: kills, deaths, assists, CS, gold, damage share, vision score, kill participation.

```
expected   = percentileOf(effRating within the 10 players) mapped to an expected composite
actual     = composite of the player's realised stats, same formula as 03 section 5
delta      = (actual - expected) / stddev
grade      = S+ (>1.75) | S (>1.1) | A (>0.45) | B (>-0.45) | C (>-1.1) | D
```

Grading against **expectation** rather than raw output is what makes a 70 OVR support able to
earn an S, which is the emotional point of the whole box score.

## 11. Testing

| Layer | Approach |
|---|---|
| Determinism | Same input simulated 1000x must produce one distinct output hash |
| Golden files | ~20 fixed matchups with committed expected event-log hashes; a diff forces a `sim_version` bump |
| Invariants | `t` non-decreasing; gold never negative; no event references a dead player as an actor; structures fall in order; exactly one `GAME_END` |
| Balance | The section 9 matrix, 20k sims per row, in CI |
| Fuzz | 100k random drafts including degenerate ones (5 supports, all off-role, mastery 0 everywhere) must never throw and never exceed `maxGameLength` |
| Performance | p99 `simulate()` under 50 ms |

## 12. Open questions

- **Comp modifier range.** +/-8% may be too weak to make drafting feel decisive. The balance
  target in section 9 says drafting should be worth ~5 rating points; verify against playtest
  feeling, not just the number.
- **Champion-vs-champion matchups.** v1 has no lane counter table. Adding one (a sparse matrix
  of ~200 notable matchups, mined from real pro winrates) would deepen bans considerably. It is
  the highest-value v1.1 addition to the sim.
- **Narration volume.** One line per event may be too chatty at 60x playback. Possibly rank
  events by importance and only narrate the top tier.
- **Should momentum exist at all?** It is unfalsifiable flavour. Keep it only if playtesters
  describe comebacks as exciting rather than arbitrary.
- **Patch eras.** `RulesPreset` supports them; should a league be able to pick "2017 rules"
  as a novelty mode?
