# 10 — Roadmap

## 1. Build order principle

Build the **risky and unknown** parts before the **laborious and known** parts.

The two things that can kill this project are (a) the simulation not being fun or not being
tunable, and (b) the data pipeline not producing cards that feel right. Both are solvable
offline, with no UI, no auth and no database. Both should be proven before a single screen is
styled.

Everything else — collection screens, league plumbing, standings — is work, not risk.

```
Risk-first:        SIM  →  PIPELINE  →  thin vertical slice  →  real UI
Not:               auth → screens → ... → "now let's write the sim"
```

## 2. Milestones

### M0 — Foundations (week 1)
- pnpm monorepo, TypeScript strict, ESLint with boundary rules, Vitest.
- `packages/core`: types and the shared formulas (`effRating`, `masteryFactor`, `roleFit`,
  `chemistryFor`, `rarityForOvr`, `gradeFor`), fully unit-tested.
- `packages/db`: initial migrations from [07](07-data-model.md), Supabase local via CLI.
- Supabase project, Discord OAuth, `profiles` table, sign-in working end to end.

**Done when:** you can sign in with Discord and see your handle. Nothing else.

### M1 — Simulation engine (weeks 2-4) — *the real work*
- `packages/sim` per [04](04-simulation-engine.md): state, tick loop, power model, contests,
  objective scheduling, sieges, victory, box score.
- `BALANCE` as a single exported object.
- **CLI harness** `pnpm sim:match --blue fixtures/teamA.json --red fixtures/teamB.json` that
  prints a text play-by-play. This is the primary development interface for weeks.
- **Monte Carlo harness** `pnpm sim:balance` with the section 9 target matrix as a CI gate.
- Golden-file tests, invariant tests, fuzz tests.

**Done when:** every balance target is green, and reading the text play-by-play of a random
match is *enjoyable*. If the text version is boring, the animated version will also be boring —
it will just take longer to find out.

### M2 — Data pipeline (weeks 3-5, parallel with M1)
- Ingest, normalise, aggregate, rate, pool, mint, publish per [03](03-data-pipeline.md).
- Start with **one year** (2024) end to end before touching the rest.
- The anchor set in `config/anchors.json` is written **before** the rating formulas, not after.
- Licence verification tasks from [03 section 11](03-data-pipeline.md) start in week 3 — they
  have external latency and must not block in week 10.
- Ship `fixtures/mini-catalogue.json` (~120 cards) for local dev.

**Done when:** a published catalogue passes validation, and showing the top 20 cards per role
to someone who follows LoL produces agreement rather than laughter. That eyeball test is the
real acceptance criterion.

### M3 — Vertical slice (week 6)
A single ugly page that: picks two hardcoded lineups, runs a hardcoded draft, calls
`simulate()`, and prints the event log as text. No auth, no league, no styling.

**Done when:** the whole pipeline from cards to a match result runs in the browser's network
tab. This is the integration risk retired.

### M4 — League & collection (weeks 7-9)
- Leagues, invite codes, membership, season and fixture generation.
- Starter squad grant, pack entitlements, pack claim with pity and role weighting.
- Collection screen, card detail, lineup editor.
- Credits ledger and rewards.

**Done when:** six accounts can form a league, open packs for a simulated week, and set
lineups. Matches still resolve with an auto-draft and a text result.

### M5 — Live draft (weeks 10-12) — *the second risk*
- `DraftRoom`, timers, the three-layer expiry safety net, persistence, rehydration.
- Supabase Realtime broadcast and presence, reconnect resync, polling fallback.
- Auto-draft agent with pick/ban scoring and top-3 noise.
- The draft screen per [09 section 7](09-screens.md).

**Done when:** two phones on different networks complete a draft, one of them backgrounded
mid-draft and recovering, and one of them never showing up at all.

### M6 — Replay (weeks 13-15)
- Canvas renderer, `ReplayClock`, `ReplayState`, interpolation, layers.
- Scoreboard, gold sparkline, event ticker, scrubber, speed controls, skip.
- Reduced-motion ticker-only mode.

**Done when:** a playtester watches a full replay without reaching for the skip button.

### M7 — Season loop (weeks 16-17)
- Standings with full tiebreaks, schedule, match history, playoffs, champion, season reset.
- Result screen, grades, "what decided it", share images.
- Reschedule requests and league pause.

**Done when:** a league can be played from an invite code to a champion and then played
again, without an operator touching the database.

Where it stands: standings, schedule, match history, the playoff bracket, the champion, the
placing payouts and the season reset are built ([01 section 7](01-game-loop.md) marks each
point). The result screen and grades are built; "what decided it" and share images are not —
share images are listed again as a v1.1 item below, which is where they belong. Reschedule
requests and league pause are not built, and they are the same missing machinery as forfeits
([05 section 7](05-draft-and-live-session.md)): all three need a way to say that an evening
did not happen.

### M8 — Playtest & tune (weeks 18-20)
- One real 14-day season with six real friends.
- Instrument everything in [00 section 8](00-vision-and-scope.md) as metrics, not vibes.
- Expect to spend most of this period on `BALANCE` and on draft-screen ergonomics.

**v1 ships at the end of a second successful season, not the first.**

## 3. Parallelisation

| Track | M0 | M1 | M2 | M3 | M4 | M5 | M6 | M7 |
|---|---|---|---|---|---|---|---|---|
| Sim | | ███ | | ░ | | | | ░ |
| Data | | | ███ | | ░ | | | |
| App | ███ | | | ███ | ███ | ███ | ███ | ███ |

With one developer, M1 and M2 interleave and the timeline stretches to roughly 26 weeks.
With two, the sim/data track and the app track run cleanly in parallel.

## 4. v1.1 — the obvious next additions

Ordered by value per unit of work:

1. **Champion matchup matrix.** A sparse table of ~200 notable lane matchups mined from real
   pro winrates, feeding a lane-power modifier. Transforms bans from "deny their pool" to
   "deny their pool *and* counterpick". Highest value in the list by a wide margin.
2. **Fearless draft mode.** Champions used earlier in the season become unavailable. Forces
   collection breadth, which is the whole point of the collection. Cheap to build.
3. **Push notifications.** Match in 15 minutes, your turn in the draft, result ready.
4. **Share images.** Result cards and card comparisons as 1200x630 images.
5. **Spectating.** Other league members watch a live draft (with a pool-information decision
   to make first).
6. **Multi-slot packs** and a better opening ritual.

## 5. v2 — the management layer

This is where the "manager" fantasy actually lands. The v1 architecture is built so that none
of this requires reshaping the schema.

### 5.1 Market and squad building
- **Transfer market** between managers in a league: offers, counter-offers, deadline day.
- **Auction house** for cards released into a league-wide pool.
- **Release for value**: convert unused cards back into credits or tokens.
- A second currency may become necessary here; v1's single-currency discipline exists to
  keep that decision open rather than forced.

### 5.2 Training and development
- **Weekly training plan**: assign each player to a focus (laning / teamfight / vision /
  champion practice). Gains accrue to sub-stats and to mastery on specific champions.
- **Form and fatigue**: a rolling modifier from recent performance and consecutive games.
  Creates rotation decisions, which creates a reason to own more than five players.
- **Scrim block**: spend a day simulating against a Ghost to gain XP instead of playing a
  fixture. The rest-day filler.

### 5.3 Staff and facilities
- Real coach progression rather than the four flat archetypes of v1.
- Analysts that reveal more of the opponent's pools before a draft.
- A facility track that raises training efficiency.

### 5.4 Scouting
- Spend credits to reveal an opponent's bench, their recent bans, their strategy tendencies.
- A "tendency profile" generated from a manager's actual draft history — the most interesting
  feature on this entire list, because it is player-generated content with zero content cost.

### 5.5 Competition structure
- Bo3 and Bo5 series for playoffs, with sideboard/fearless interactions.
- Multi-split seasons with promotion and relegation across linked leagues.
- Cross-league tournaments.

### 5.6 Collection depth
- Card variants (Worlds edition, rookie season) as rarity flavour, never as power.
- Historical "Classics" packs with curated pre-2018 player-seasons.
- Achievements and an all-time honours cabinet on the profile.

## 6. Deliberately never

| Not doing | Why |
|---|---|
| Paid packs / real-money loot boxes | [00 section 7](00-vision-and-scope.md). Changes the legal posture of the data entirely |
| Betting or odds | Same |
| Public matchmaking at launch | The product is a friend-group ritual; open leagues are a different game |
| Player ratings that a designer can override | Destroys the one thing that makes the cards credible |
| Wiping collections between seasons | Punishes the people who played most |

## 7. Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| Oracle's Elixir terms refuse this use | High — ratings have no source | Start the conversation in week 3. Fallback: Leaguepedia Cargo aggregates (worse columns, much more work) |
| Sim is tunable but not *fun* | Fatal | M1 gates on the text play-by-play being enjoyable, before any UI investment |
| Live synchronous matches do not survive real schedules | High | Auto-draft, reschedule tokens, rest days, league pause — all in v1, all specified in [05 section 7](05-draft-and-live-session.md) |
| Collection snowball decides seasons | High | Balance targets in [04 section 9](04-simulation-engine.md) are a CI gate, not an aspiration |
| Single Nitro instance dies mid-draft | Medium | Rehydration from `draft_actions`, deploy windows away from match hours, documented v2 path to Redis |
| Player portrait rights | Medium | Generated avatars are the default; real portraits are opt-in per cleared file |
| Replay is skipped by everyone | Medium | It is the payoff; if playtest criterion 2 fails, shorten games and increase narration density rather than adding spectacle |
| Scope creep into the management layer before v1 ships | High | [00 section 6](00-vision-and-scope.md) is the contract. v2 features go in this document, not into the build |

## 8. First three tasks

For whoever picks this up on Monday:

1. `pnpm init` the monorepo, create `packages/core`, and implement `effRating` with its tests.
   It is 40 lines and it is the centre of the whole design.
2. Download the 2024 Oracle's Elixir CSV, load it into a local Postgres, and compute the top 20
   mids by DPM. Confirm the column names match [03 section 1.1](03-data-pipeline.md) and write
   `config/oe-column-map.2024.json`.
3. Write `config/anchors.json` — 30 player-seasons with the OVR band you expect. Do this from
   knowledge, before writing any rating code, so the formulas are tested against a prior
   instead of justifying themselves.
