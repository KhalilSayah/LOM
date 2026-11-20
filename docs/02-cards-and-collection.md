# 02 — Cards & Collection

## 1. Card taxonomy

```
Card
 +-- PlayerCard        a player-season, e.g. faker-2024          (the heart of the game)
 +-- CoachCard         a passive team modifier applied in sim
 +-- MasteryToken      +N mastery for one card on one champion
 +-- CreditPack        soft currency
```

Only `PlayerCard` goes in a lineup. The others are consumables or passives.

## 2. PlayerCard anatomy

A PlayerCard is **immutable catalogue data** (`card_definitions`) plus **per-manager mutable
state** (`manager_cards`: level, XP, mastery deltas from tokens). The catalogue row is
produced entirely by the data pipeline ([03](03-data-pipeline.md)).

### 2.1 Identity

| Field | Example | Source |
|---|---|---|
| `card_key` | `faker-2024` | generated: `slug(player) + "-" + season` |
| `player_name` | `Faker` | Leaguepedia |
| `real_name` | `Lee Sang-hyeok` | Leaguepedia (optional, may be absent) |
| `season` | `2024` | derived from match dates |
| `team` | `T1` | most games played that season |
| `region` | `LCK` | team's league |
| `role` | `MID` | most games played that season |
| `portrait_url` | Supabase Storage key | see [03 section 8](03-data-pipeline.md) on image rights |

### 2.2 Ratings

One **OVR** (40-99) plus six sub-stats (1-99). All are computed, never authored.

The six sub-stats are strictly about the season on the card: they are z-scores of that
player's measured play inside a cohort of everyone in the same role and season
([03 section 6](03-data-pipeline.md)). OVR is not only about that season. It is the
role-weighted sum of the six, plus three terms that the sub-stats cannot see:

| Term | What it adds | Why it is not in the sub-stats |
|---|---|---|
| Accolades | Up to +10, scaled from the figures in [03 section 6.3](03-data-pipeline.md) | Winning is not visible in a box score. A Worlds-winning mid can sit below the median of his own cohort on damage and gold, because his job that year was not to lead them |
| League strength | About ±2, from how that league's teams did against other leagues that season | A weaker league produces longer, looser games and therefore better-looking per-minute numbers |
| Career standing | Lifts a season toward the best standing the player had already earned, fading 2.5 points a year | A player who has been the best in the world does not become an ordinary player in one quiet year |

**Career standing is the one that makes a card more than its season**, so it is worth being
explicit about what it does and does not claim. It only ever lifts, so no card is rated above
what that player actually did; it is rated above what *that season alone* would say. It is
causal — only seasons at or before this one count, so a card is never improved by something
that had not happened yet. And standing is measured against unlifted ratings, so a long
decline fades out instead of compounding into a plateau.

Without it, a career reads as a series of unrelated strangers: Faker's 2021 rated 61 and his
2026 rated 64, in a catalogue where his 2015 is a 98. With it, that career reads 98, 97, 89,
85, 86, 83, 75, 81, 84, 83, 83, 72 — the dip is still plainly the worst year of his career,
and the decline is a decline rather than a cliff.

A card whose OVR was lifted this way says so on its back, with the season it was carried
from. Nothing is hidden behind the number.

| Sub-stat | Plain meaning | Drives in sim |
|---|---|---|
| `laning` | Wins the first 15 minutes | Lane-phase power, plate/first-tower rolls |
| `teamfight` | Damage and impact in 5v5 | Teamfight contest power (mid/late) |
| `mechanics` | Raw individual execution | Skirmish and 1v1/2v2 contest power, solo kills |
| `macro` | Map movement, objective setup, rotations | Objective contest power, roam events |
| `vision` | Ward control and denial | Ambush/pick probability both ways, objective setup |
| `consistency` | How little the performance varies | Shrinks this player's per-event variance |

`clutch` is deliberately **not** a sub-stat — it is modelled as a derived modifier applied only
in late-game and elimination contexts, because treating it as a flat stat would double-count
teamfight. See [04 section 5.4](04-simulation-engine.md).

### 2.3 Champion pool

An array of up to 15 entries, ordered by games played:

```jsonc
"champion_pool": [
  { "champion": "Azir",    "games": 31, "mastery": 94, "winrate": 0.58 },
  { "champion": "Orianna", "games": 22, "mastery": 88, "winrate": 0.64 },
  { "champion": "Ahri",    "games": 14, "mastery": 79, "winrate": 0.50 }
]
```

Champions outside the pool are **not forbidden** — they are drafted at `mastery = 0`, which is
a severe penalty (see section 2.4). This keeps the draft open while making the collection matter.

### 2.4 Effective rating on a champion

The single most important formula in the game. Used by the sim for every contest.

```
masteryFactor(m)  = 0.70 + 0.30 * (m / 100)          # 0.70 at m=0, 1.00 at m=100
roleFit(champ, slot) = 1.00  native role
                     = 0.90  flex (champion has >=10% pro presence in that role, same season)
                     = 0.72  off-role

effRating(card, champ, slot) =
    clamp( (ovr + levelBonus) * masteryFactor(mastery) * roleFit(champ, slot), 30, 99 )
```

A 92 OVR mid on an unmastered champion lands at ~64 — roughly a low-tier card. A 78 OVR mid on
a 95-mastery main lands at ~77. That crossover is the design goal: **pool depth beats raw OVR**.

`levelBonus` is `0.4 * (level - 1)`, max `+3.6` (see [01 section 5](01-game-loop.md)).

### 2.5 Synergy / chemistry

A small team-level bonus, capped so it can never dominate:

| Condition | Bonus |
|---|---|
| Two cards shared a real team in the same season (e.g. `faker-2024` + `keria-2024`) | +1.5 effRating each |
| Three or more such cards | +2.5 each (does not stack with the above) |
| All five from the same region | +1.0 each |
| All five from the same season year | +1.0 each |

Max total chemistry: **+4.5** per player. Chemistry is shown on the lineup screen as a
connection graph — it is a *nice to have*, not a *must build around*.

### 2.6 Non-player cards

**CoachCard** — a passive applied to the whole team while equipped. One coach slot per lineup.

| Example | Effect |
|---|---|
| `Draft Specialist` | +1 effective ban (your 6th ban is auto-chosen from the opponent's top pools) |
| `Early Game Coach` | +6% team power in phase EARLY |
| `Objective Caller` | +8% to dragon/baron contest rolls |
| `Vision Coach` | +10 team vision score, improves pick-event odds |

Coaches are **fictional archetypes**, not real people. This avoids both data problems and
likeness problems, and it keeps them from competing with player cards for collection attention.

**MasteryToken** — `+12 mastery` for one owned card on one champion, cap 100. Tokens are
typed: `MID`, `JNG`, etc., and a generic `ANY` at lower drop rate.

**CreditPack** — 100 / 250 / 600 Credits.

## 3. Rarity

Rarity is a **presentation and drop-rate axis derived from OVR plus accolades**, not an
independent power axis. It exists so pack openings have a readable moment of excitement.

| Tier | OVR band | Extra condition | Catalogue share (target) |
|---|---|---|---|
| `COMMON` | 40-67 | — | 45% |
| `RARE` | 68-76 | — | 30% |
| `EPIC` | 77-84 | — | 17% |
| `LEGENDARY` | 85-91 | — | 6.5% |
| `ICON` | 92-99 | **and** won Worlds, an international final, or a season MVP | 1.5% |

An ICON-band OVR without the accolade stays LEGENDARY. This is what keeps "Faker 2016" and
"Faker 2021" feeling different, and what makes the ICON shelf a short, memorable list.

The catalogue shares are enforced by the rating normalisation in
[03 section 6](03-data-pipeline.md) — if the distribution drifts, the band cutoffs are
recalibrated, not the ratings.

## 4. Starter squad

On league start every manager gets exactly 5 PlayerCards, one per role, drawn with these
constraints:

- OVR band **72-80** (RARE/low-EPIC). Nobody starts with an ICON.
- Each card has **>= 3** champions at mastery >= 70, so the first drafts are playable.
- No two managers in a league get the same `card_key`.
- Seeded by `league_id` so a league's starter grant is reproducible and auditable.
- Plus: 1 `STANDARD` coach card, 3 generic mastery tokens, 500 Credits.

## 5. Packs

### 5.1 Entitlement

- 1 free pack per manager per league-day, created at the 00:00 day roll.
- Unclaimed packs **bank up to 3**. Beyond that, the oldest expires. This forgives a weekend
  away without letting someone hoard a month of packs into one opening.
- Everything else is bought with Credits, and some types are capped per day (section 5.1.1).
- A pack can also be **gifted** (section 5.1.2), which is neither free-daily nor bought.

### 5.1.1 Pack types

Section 8 used to ask whether a pack should be one slot or several. The answer is both, and
which one you get is what you are paying for: **cheap packs sell quantity, expensive packs
sell quality**.

| Pack | Price | Slots | What it can produce | Per day |
|---|---|---|---|---|
| Daily | free | 1 | the full table below | 1 |
| Scouting | 150 | 3 | nothing above EPIC | — |
| Signing | 400 | 5, **one per lane** | nothing above LEGENDARY | — |
| Standard | 300 | 1 | the full table below | 2 |
| Legacy | 2500 | 3 | one slot LEGENDARY at worst | — |

The **Signing pack** is the one that shapes early play. Five cards, one for each role, mostly
ordinary — it is how a manager goes from nothing to a fieldable squad in a single purchase,
which is the same five-card, one-per-role shape the starter squad in section 4 has. It is
deliberately poor value per card and excellent value per *lineup*.

Prices and odds live in the `pack_types` table rather than in code. They are the numbers most
likely to be wrong on the first attempt, and correcting them should be an `UPDATE`, not a
deploy.

**Pity is shared across every pack type.** A five-card pack advances the counter five times,
and a Legendary from any pack resets it. One counter, counting cards, is the only reading
that keeps "Legendary within 40" an honest promise — and pity outranks a pack's own ceiling,
so a Scouting pack still pays a guarantee the manager has already earned.

### 5.1.2 Gifted packs

A gift is a pack a manager owns but has not rolled yet: a row in `pack_gifts` naming a pack
type, a title and a line of copy. Every account gets one Signing pack this way — new accounts
from the signup trigger, accounts that already existed from the backfill in migration 0008 —
and an operator can hand out more from the SQL editor with `grant_pack_gift_by_handle()`.

Three things follow from a gift being an entitlement rather than a grant of cards:

- The cards are rolled **when it is opened**, against whatever catalogue is active then. A
  gift handed out in March is not a snapshot of March's catalogue.
- The unopened row **is** the notification. There is no second table saying "you have mail",
  because a notification that can disagree with the thing it announces eventually does. The
  toast is shown once (`seen_at`); the nav dot and the call-out on the pack screen stay until
  `opened_at`.
- A gift does **not** spend the day's allowance. Being given a Standard pack must not cost a
  manager one of the two they can buy, so the opening carries no `pack_day`.

`reason` is the campaign key and is unique per manager, which is what makes granting
idempotent — the trigger and the backfill can both run as often as they like. A second round
of gifts is a new reason, not a second `WELCOME`. A gifted pack advances pity like any
other.

### 5.2 Pack contents

Every slot is a PlayerCard. Mastery tokens, coach cards and credit drops are not in v1
because none of them have anything to spend themselves on yet.

Rarity roll for a slot in the daily or Standard pack; other packs use their own weights and
the caps in 5.1.1:

| Tier | Base | With pity |
|---|---|---|
| COMMON | 52% | |
| RARE | 30% | |
| EPIC | 13% | |
| LEGENDARY | 4.4% | guaranteed by pack 40 since last Legendary+ |
| ICON | 0.6% | guaranteed by pack 150 since last ICON |

**Pity counters** are per manager, persisted, and reset on trigger. They are visible in the UI
("Legendary in at most 12 packs") because hidden pity is just anxiety.

**Role weighting.** 30% of PlayerCard pulls are biased toward the manager's *thinnest* role
(fewest owned cards). Nobody should be stuck starting a 68 OVR jungler on day 9 because the
RNG never gave them one.

### 5.3 Duplicates

Pulling a card you own does not give a second copy. Instead:

- The card gains **+250 XP** (roughly 1.5 levels at low level).
- You receive Credits, by what you pulled: 15 / 30 / 60 / 150 / 400 from COMMON to ICON.

The spec used to pay a mastery token here, with Credits only for a duplicate of a level-10
card. Tokens do not exist yet, and until the match rewards in [01 section 5](01-game-loop.md)
are wired up nothing else in the game produces Credits at all — so duplicates are the
economy's only source, and paying every one of them is what keeps it turning. When matches
start paying out, this is the line to revisit.

No dust/shard currency in v1 — one currency is enough.

## 6. Collection screen requirements

- Default view: grid, grouped by role, sorted by OVR descending.
- Filters: role, rarity, region, season year, team, "has mastery on champion X".
- Search by player name or champion name.
- Card detail shows: portrait, OVR, six sub-stats as a radar, full champion pool with mastery
  bars, level/XP bar, real-season box-score summary (games, KDA, GD@15, DPM), accolades, and a
  **data provenance line** ("Derived from 68 games, LCK + Worlds 2024 — source: Oracle's
  Elixir / Leaguepedia").
- Comparison mode: pin two cards side by side. This is the group-chat screenshot feature.

## 7. Balance guards

| Risk | Guard |
|---|---|
| Collection snowball decides the season | `masteryFactor` floor of 0.70 and the sim's logistic compression ([04 section 9](04-simulation-engine.md)) |
| One manager hoards a role | Thinnest-role pack weighting (section 5.2) |
| Chemistry forces mono-team squads | Chemistry capped at +4.5, which is less than one mastery tier |
| Card levels create power creep | +3.6 OVR max, hard cap, no prestige in v1 |
| ICON cards feel mandatory | ICON OVR advantage over LEGENDARY is <= 8 OVR, worth ~4% win probability per [04 section 9](04-simulation-engine.md) |

## 8. Open questions

- **Should duplicates be tradeable within a league?** Trading is a v2 feature, but duplicate
  gifting might be a cheap early social hook.
- **Coach card depth.** Four archetypes may be too few to bother with a coach slot at all;
  consider folding coaches into v2 if they feel vestigial in playtest.
- **Mastery cap at 100.** Should token spend be able to push a card above its real-season pool
  breadth, or is that a lore violation worth enforcing?
