# 01 — Game Loop

## 1. Three nested loops

```
SEASON LOOP          14 days -> playoffs -> champion -> reset, collection kept
  |
  +-- DAILY LOOP     pack -> lineup -> live draft -> sim -> replay -> standings
        |
        +-- DRAFT LOOP   20 actions, 30 s each, alternating
```

## 2. League creation

1. A manager creates a league: name, **timezone**, **match hour** (local, e.g. 20:30),
   season length (default 14 days), start date.
2. The app generates a 6-character invite code. Others join with it.
3. League locks when the creator presses **Start season**, or automatically at the start date.
4. On lock: fixtures are generated, starter squads are granted, day 1 begins.

**Size rules**

| Managers | Fixture generation | Notes |
|---|---|---|
| 2 | Repeated head-to-head | Allowed, minimal mode |
| 3, 5 | Round robin with a bye each round | The bye manager plays a **Ghost** match (section 6) |
| 4, 6 | Clean round robin | The intended configuration |

Target: 6. Double round-robin at 6 managers = 10 match days, + 1 rest day, + 3 playoff days = 14.

## 3. The season calendar

For a 6-manager league, 14 days:

| Day | Content |
|---|---|
| 1-5 | Round-robin cycle 1 (each manager plays all 5 opponents once) |
| 6 | **Rest day** — no fixture. Pack still drops. Used as buffer for reschedules. |
| 7-11 | Round-robin cycle 2 (reversed side assignment: blue/red swap) |
| 12 | Semi-finals — seeds 1v4 and 2v3 |
| 13 | **Rest day** / third-place match (optional) |
| 14 | Final |

Seeds 5 and 6 play an exhibition on days 12 and 14 so everyone still has a daily match.
Rest days exist because a 14-day streak of mandatory live attendance is unrealistic; see
[05 section 7](05-draft-and-live-session.md) for the reschedule mechanism that uses them.

**Standings order:** points (win 3, loss 0) -> head-to-head -> game-time differential (sum of
`opponent_game_length - own_game_length` across wins, rewarding fast closes) -> total kills ->
deterministic coin flip seeded from `league_id`.

**The playoff days are not generated at launch**, because they need a table and a table needs
matches that have been played. They are appended the moment the last **regular** fixture goes
FINAL — from the server, in the same call that writes the result, for the reason section 8
gives for the standings: a season that waits on somebody opening the app is a season that can
be held hostage. Ghost fixtures do not gate it; nobody is obliged to play a bye. The gaps are
relative, so the shape above survives a league whose regular season was a different length:
semis the day after the last regular fixture, a rest day, then the final. The league owner
also has a button for it, which calls the same code with the same guards — it is the repair
path for an evening when the automatic call failed, not a way to force a bracket onto an
unfinished season (that would be a forfeit, and forfeits are
[05 section 7](05-draft-and-live-session.md)).

**Smaller brackets.** Four or more managers get the top four and the bracket above. Three get
a bye: the top seed goes straight to the final, and seeds 2 and 3 play for the right to meet
them — an empty fourth seat would be a semi-final somebody wins by walking. Two play a final
and nothing else, which is the only thing a bracket can add to a season they have spent
playing each other. The higher seed always drafts first, in every round; the regular season
reversed sides every cycle precisely so that this is the one place it is earned.

## 4. The daily loop in detail

All times are league-local. `M` = the league's match hour.

### 00:00 — Day roll
- `day_index` increments. A new fixture becomes `scheduled`.
- A **pack entitlement** is created for every manager.
- Yesterday's unclaimed packs remain claimable (max 3 banked; see
  [02 section 5](02-cards-and-collection.md)).

### Any time before `M` — Preparation
- **Claim pack.** Reveal animation, card goes into the collection.
- **Set lineup.** Pick 5 cards, one per role slot. The previous day's lineup is pre-filled;
  if a card is still in the squad it stays selected, so doing nothing is always valid.
- **Set strategy.** One of three presets, applied to the whole team for the match:

  | Preset | Effect in sim |
  |---|---|
  | `STANDARD` | No modifiers. |
  | `AGGRESSIVE` | +12% skirmish frequency, +8% early-game power, -6% late-game power, -10% objective-setup power. |
  | `SCALING` | -10% early-game power, +10% late-game power, +15% to tower/turtle defence rolls. |

  Strategy is visible to the opponent **only after** the draft completes.
- **Scout.** Read-only view of the opponent's last 3 matches and their *starting lineup's*
  champion pools. Their exact lineup is hidden until draft start. (Their full collection is
  never visible — that is a v2 scouting feature.)

### `M - 15 min` — Lobby opens
- Both managers can enter the match room. Presence is broadcast.
- A countdown shows. One push/web notification fires (v1.1).

### `M` — Draft starts
- See [05 — Draft & live session](05-draft-and-live-session.md). Roughly 6 minutes.
- If a manager is absent, the auto-draft agent plays for them. The match is never cancelled.

### `M + ~6 min` — Simulation
- Server runs `@lom/sim` with seed `hash(fixture_id)`. Takes < 50 ms.
- The complete event log is written to the database before any client sees a result.
- Result is **not** revealed in the UI until the replay is watched or skipped.

### Replay
- 2D map animation of the event log. Default playback 60x (a 32-minute game ~ 32 s), with
  pause, 1x/2x/4x scrub on the timeline, and **Skip to result**.
- Both managers watch independently; there is no synchronised viewing requirement.

### Post-match
- Box score per player: K/D/A, CS, gold, damage share, vision score, **performance grade**
  (S+/S/A/B/C/D) computed against that card's expected output.
- Standings update. Rewards granted (section 5).
- Match is archived and rewatchable forever from the league history.

## 5. Rewards

v1 keeps the economy tiny on purpose: one soft currency (**Credits**) and card XP.

| Event | Credits | Card XP (to the 5 starters) |
|---|---|---|
| Play a match | 50 | 20 each |
| Win a match | +100 | +15 each |
| Player earns an S-grade | +25 | +40 to that card |
| First win of the season | +200 | — |
| Finish season 1st / 2nd / 3rd-4th / else | 1500 / 900 / 500 / 250 | — |

**Credits spend on:** packs, which come in several shapes at several prices — see
[02 section 5.1.1](02-cards-and-collection.md). A mastery token for a specific champion (500)
and a daily-pack re-roll (150) are still unbuilt.

**Credits come from:** every row of the table above, plus the sponsors a manager has signed
([12](12-sponsors.md)) and duplicate pulls. A finished match writes one `match_rewards` row
per manager and pays against it; the unique index on `(duel_id, profile_id)` is what makes a
duel that finishes twice pay once. The receipt is stored on that row and the result screen
renders it, rather than recomputing numbers that could then disagree with the ledger.

The **season placings are live.** A league has a finish now: the bracket is drawn the moment
the last regular fixture is decided, the grand final sets `leagues.status` to FINISHED with a
champion on it, and the placings pay against one `season_rewards` row per manager per season
— the same idempotency shape as a match, so a season that settles twice pays once. Who
finished where comes from the bracket, not from the table: a first seed that loses the final
is paid as the runner-up, because that is what it is. 1st and 2nd are the two finalists, 3rd
and 4th the beaten semi-finalists, and everybody else keeps their regular-season position
and the 250. See section 7, `shared/playoffs.ts` and `supabase/migrations/0013_playoffs.sql`.

Two details are not in this table. A Ghost pays at 50% (section 6), and past **three paid
Ghost matches in a pack-day** a Ghost pays card XP and no Credits at all — the Ghost here is
the bye in an odd league, one a day, but `/api/duel/queue/bot` will hand out an agent
opponent on demand and an unbounded Ghost is a faucet with a tap on it. And the first win of
the season is a league question: it is decided from the other fixtures in that league, so a
friendly cannot be the first win of anything.

**Card XP** levels a card 1 -> 10. Each level grants **+0.4 OVR** (max +3.6) and at levels 3, 6
and 9 a **+8 mastery** bump to the card's most-played champion. This is the only progression
in v1 and it is deliberately shallow — it makes playing your favourites feel good without
letting the game drift into power creep. Full training systems are v2.

## 6. Ghost matches

When a league has an odd manager count, the bye manager plays a **Ghost**: an auto-generated
opponent whose squad is sampled from the card catalogue at the league's current average OVR
+/- 3, drafted by the auto-draft agent. Ghost matches:

- Award Credits and card XP at **50%**.
- Do **not** count toward the standings.
- Still produce a full replay and box score.

They exist so nobody has a dead day.

## 7. Season reset

When the grand final is decided:

1. Champion is recorded in the league's honours board. **Built** — `leagues.champion_member_id`
   is written in the same update that sets `status` to FINISHED, so there is never a finished
   league without one.
2. Season rewards pay out. **Built** — one `season_rewards` row per manager per season, the
   claim written before a single Credit moves, and the unique index on
   `(league_id, season, profile_id)` is what makes a league that settles twice pay once. The
   numbers are the last row of section 5.
3. **Collections are kept in full.** Nothing is wiped. Card levels persist. Built by doing
   nothing, which is the point: no code anywhere touches a collection at a season boundary.
4. A new season can be started by the league owner. New fixtures, standings cleared.
   **Built** — the owner gets a *Start season N* button on a finished league. "Standings
   cleared" is read as *a different question*, not as a deletion: a fixture belongs to a
   season (`league_fixtures.season`), so season 1's calendar, results, replays, standings and
   payouts are all still there to read, and the table is empty because it is asking about
   season 2. The catalogue is re-pinned, because a season played months later should be
   played on the cards that exist by then ([03 section 9](03-data-pipeline.md)).
5. A **Season Pack** is granted to every manager: guaranteed Epic-or-better player card.
   **Built** — one card with an Epic floor, granted when the grand final is decided rather
   than when the next season starts, so a league that never plays again still hands them out.
   Flat for everyone who finished, not scaled by placing: the placings in section 5 already
   pay by position, and a reward only the champion gets is a reward that makes a sixth-place
   manager close the app. It is a pack type nobody can buy — `is_active = false`, which the
   shop and the buy route filter on and the gift route does not.

The honours board of point 1 is `league_seasons`: one row per season a league has finished,
with its champion and how long it was. `leagues.champion_member_id` holds the champion of the
*current* season only — null while one is being played, cleared when the next starts — so the
board is what outlives it.

The anti-runaway control is that daily packs are identical for everyone and the sim compresses
rating differences ([04 section 9](04-simulation-engine.md)). If, after two seasons of
playtesting, the first-season winner still dominates, the fix is a reverse-order **Season
Draft** of a shared pack pool, not a collection wipe. Tracked as an open question.

## 8. State machine — fixture

```
scheduled    --(lobby opens, M-15)-->  lobby_open
lobby_open   --(M reached)----------->  drafting
drafting     --(20th action resolved)->  simulating
simulating   --(event log written)--->  ready        # result exists, unviewed
ready        --(both viewed OR M+24h)->  final
any          --(league owner cancels)->  voided
```

`simulating` is expected to last milliseconds; it is a distinct state so that a crashed sim
is visible and retryable rather than leaving a fixture stuck in `drafting`.

A fixture auto-advances `ready -> final` 24 hours after simulation regardless of viewing, so
standings cannot be held hostage by someone who refuses to open the app.

## 9. Open questions

- **Rest-day cadence.** Is 1 rest day per 5 match days enough for a group of adults? Playtest.
- **Strategy presets.** Three may be too few to be interesting, or exactly right for v1.
  Decide after the balance pass; the sim supports arbitrary modifier bundles.
- **Playoffs at 6.** 1v4 / 2v3 is what got built, and it does leave seeds 5-6 with nothing:
  the exhibition matches section 3 mentions for them are not generated, so in a six-manager
  league two people have three empty evenings at the end of a season. The alternatives are a
  full six-team bracket with byes for 1 and 2, or exhibitions as a stage that pays like a
  Ghost. Needs a playtest to say which is the real problem — three quiet evenings, or a
  bracket nobody can hold in their head.
- **Anti-runaway.** Season draft vs. pure daily-pack equality — needs two seasons of data.
