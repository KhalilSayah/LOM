# 03 — Data Pipeline

How real professional League of Legends data becomes a playable card catalogue.

> **Verify before you build.** Every licence and endpoint described here must be re-checked
> against the source's current terms at implementation time. The terms summarised below are
> what the project *assumes*; section 8 lists exactly what has to be confirmed and what the
> fallback is if an assumption fails.

## 1. Sources

| # | Source | What it gives | Access | Assumed terms |
|---|---|---|---|---|
| S1 | **Oracle's Elixir** (`oracleselixir.com/stats`) | Per-player, per-game rows for essentially all professional LoL matches since 2014. The statistical backbone. | Yearly CSV downloads (one file per year, ~100-150 MB, ~10 columns x 100k+ rows) | Free for non-commercial use with attribution; commercial use requires contacting the maintainer |
| S2 | **Leaguepedia** (`lol.fandom.com`) | Player identity, real names, team rosters, tournament metadata, results, accolades, player images | Cargo API (`/api.php?action=cargoquery`) and MediaWiki API | Text content CC BY-SA; images have per-file licences and must be checked individually |
| S3 | **Data Dragon** (`ddragon.leagueoflegends.com`) | Champion list, champion IDs/keys, tags, icons, splash art, per-patch versions | Static CDN JSON + images, no key | Riot-provided, free to use under Riot's Legal Jibber Jabber policy for non-commercial community projects |
| S4 | **Community Dragon** (`raw.communitydragon.org`) | Higher-resolution and historical champion/item assets Data Dragon drops | Static files | Community mirror of Riot assets; same Riot policy applies |
| S5 | **lolesports** (`esports-api.lolesports.com`) | Live schedule, standings, team logos | Unofficial, undocumented, widely used public key | **Unsupported.** Treat as a nice-to-have only; never on the critical path |
| S6 | **Riot Developer API** (Match-V5, Account-V1) | Solo-queue matches | Official, API key, rate-limited | Only relevant if amateur/solo-queue cards are ever added. **Not used in v1** |

**v1 uses S1 + S2 + S3.** S1 is the only source of ratings. S2 supplies identity and accolades.
S3 supplies the champion dimension. S4 is an asset fallback. S5 and S6 are out of scope.

### 1.1 Why Oracle's Elixir rather than scraping

It is already normalised, already covers every major and most minor regions back to 2014, and
is a flat file — no scraping, no rate limits, no brittle HTML selectors, and one attribution
line instead of a legal argument. The columns the ratings need are all present:

```
gameid, datacompleteness, league, year, split, playoffs, date, patch, participantid,
side, position, playername, playerid, teamname, teamid, champion, ban1..ban5,
gamelength, result, kills, deaths, assists, teamkills, teamdeaths, firstblood,
damagetochampions, dpm, damageshare, damagetakenperminute, wardsplaced, wpm,
wardskilled, wcpm, controlwardsbought, visionscore, vspm, totalgold, earnedgold,
earned gpm, goldspent, total cs, cspm, goldat10, xpat10, csat10, golddiffat10,
xpdiffat10, csdiffat10, goldat15, xpat15, csat15, golddiffat15, xpdiffat15,
csdiffat15, dragons, barons, towers, ...
```

Column names drift slightly between years. The ingest stage pins a **column map per year**
rather than trusting a stable header (section 3.1).

## 2. Pipeline shape

A standalone Node/TypeScript package, `packages/data-pipeline`, run as a scheduled job. It
does **not** run inside the web app — it writes to the same Postgres instance and is otherwise
independent.

```
 [S1 CSV]  [S2 Cargo]  [S3 ddragon]
     |         |           |
     v         v           v
  (1) INGEST  -> raw_* tables, append-only, content-hashed
     |
  (2) NORMALISE -> canonical player identity, team, role, tournament tier
     |
  (3) AGGREGATE -> one row per (player, season) with ~40 metrics
     |
  (4) RATE      -> six sub-stats + OVR, cohort-normalised
     |
  (5) POOL      -> champion pool with mastery per card
     |
  (6) MINT      -> card_definitions rows, rarity assigned, assets resolved
     |
  (7) PUBLISH   -> new catalogue_version, validated, flipped live
```

Each stage is a separate command (`pnpm pipeline ingest --year 2024`) and is **idempotent**:
re-running a stage with the same inputs produces the same outputs and overwrites nothing that
was not derived.

## 3. Stage 1 — Ingest

### 3.1 Oracle's Elixir
- Download `{year}_LoL_esports_match_data_from_OraclesElixir.csv` for each year in scope.
- Store the raw file in Supabase Storage under `pipeline/raw/oe/{year}/{sha256}.csv` so every
  run is reproducible from the exact bytes used.
- Parse streaming (`papaparse` or `csv-parse` in stream mode) — never load the whole file.
- Apply `config/oe-column-map.{year}.json`, which maps that year's header spellings to
  canonical names. Unknown columns are logged and ignored; a **missing required column aborts
  the run**.
- Drop rows where `datacompleteness != "complete"` and rows where `position == "team"`
  (those are team-aggregate rows, kept separately in `raw_oe_team_rows`).
- Write to `raw_oe_player_rows`, keyed `(gameid, participantid)`.

### 3.2 Leaguepedia
- Cargo queries, paginated at 500, with a 1 req/sec ceiling and a persistent ETag cache.
- Tables used: `Players`, `PlayerRedirects`, `Tournaments`, `TournamentResults`, `Teams`.
- Purpose: canonical player identity (handles name changes and romanisation), team full names,
  tournament tier, and accolades (Worlds/MSI/domestic winners, MVP awards).
- Respect `Retry-After`; back off exponentially; identify the client with a project User-Agent
  that names the project and a contact URL.

### 3.3 Data Dragon
- Fetch `/api/versions.json`, take the latest patch, fetch `/cdn/{v}/data/en_US/champion.json`.
- Also fetch the **historical** champion list for each season year's final patch, because
  champion names and IDs change (`Nunu` -> `Nunu & Willump`). Store a per-year champion
  alias table so 2015 rows resolve correctly.

## 4. Stage 2 — Normalise

The hard part is **player identity**. The same human appears as different strings across years
and regions.

Resolution order:
1. `playerid` from Oracle's Elixir when present (stable per player across years) — primary key.
2. Leaguepedia `PlayerRedirects` to collapse aliases onto a canonical page name.
3. A hand-maintained `config/player-overrides.json` for the residue.

Output: `players` table with a stable `player_uid`, canonical handle, real name (nullable),
country, and the alias set.

Also normalised here:
- **Role** — `position` in {top, jng, mid, bot, sup} mapped to `TOP/JNG/MID/BOT/SUP`.
- **Tournament tier**, used as a weight in aggregation:

  | Tier | Examples | Weight |
  |---|---|---|
  | `INTERNATIONAL` | Worlds, MSI | 1.35 |
  | `MAJOR_PLAYOFF` | LCK/LPL/LEC/LCS playoffs | 1.15 |
  | `MAJOR_REGULAR` | LCK/LPL/LEC/LCS splits | 1.00 |
  | `MINOR` | LJL, CBLOL, PCS, VCS, academy | 0.80 |

  The weight matters: 40 games of an easy minor split should not rate above 12 games of Worlds.

## 5. Stage 3 — Aggregate

One row per `(player_uid, season_year)`, provided the player meets the **inclusion threshold**:

- `>= 15` weighted games in the season, **and**
- `>= 60%` of those games in one role (otherwise the player-season is skipped as unclassifiable).

A player who played two regions in one year produces **one** card; `team` and `region` come
from whichever accounted for the most games.

Metrics aggregated, all tier-weighted means unless noted:

| Group | Metrics |
|---|---|
| Lane | `golddiffat15`, `xpdiffat15`, `csdiffat15`, `goldat15`, `csat15` |
| Combat | `dpm`, `damageshare`, `damagetakenperminute`, `kills`, `deaths`, `assists`, `kp = (k+a)/teamkills` |
| Economy | `earned gpm`, `cspm`, `gold efficiency = dpm / earned gpm` |
| Vision | `vspm`, `wpm`, `wcpm`, `controlwardsbought` per minute |
| Objectives | team `dragons`, `barons`, `towers` per game, attributed to all five players |
| Volume | `games`, `weighted_games`, `winrate`, `gamelength` mean |
| Variance | per-game composite score, then its standard deviation (for `consistency`) |

All rate stats are computed **per minute against that game's length**, never as raw totals, so
a 45-minute game does not inflate a player.

## 6. Stage 4 — Rate

### 6.1 Cohort z-scores

Every metric is z-scored **within a cohort of (role, season_year)**, weighted by
`weighted_games`. Cohorts are per-year because the game itself changes: 2015 DPM is not
comparable to 2024 DPM, and comparing them directly would make every modern card better than
every classic card.

```
z(metric, player) = (value - cohort_mean) / cohort_stddev,  clamped to [-3, +3]
```

Deaths, `damagetakenperminute` (for non-tank roles) and the consistency stddev are **inverted**
before z-scoring.

### 6.2 Sub-stats

Each sub-stat is a role-weighted blend of z-scores, mapped to 1-99 by
`stat = round(clamp(50 + 14 * z_blend, 1, 99))`.

| Sub-stat | Blend (TOP / MID) | Blend (JNG) | Blend (BOT) | Blend (SUP) |
|---|---|---|---|---|
| `laning` | .45 gd15 + .30 xpd15 + .25 csd15 | .40 gd15 + .35 xpd15 + .25 cs@15 | .40 gd15 + .25 xpd15 + .35 csd15 | .55 gd15 + .45 xpd15 |
| `teamfight` | .45 dpm + .35 dmgshare + .20 kp | .35 dpm + .25 dmgshare + .40 kp | .50 dpm + .35 dmgshare + .15 kp | .25 dmg_taken + .35 kp + .40 vspm |
| `mechanics` | .40 gold_eff + .35 inv_deaths + .25 kda | .35 gold_eff + .35 inv_deaths + .30 kda | .45 gold_eff + .30 inv_deaths + .25 kda | .40 inv_deaths + .35 kda + .25 gold_eff |
| `macro` | .40 towers + .30 cspm + .30 objectives | .50 objectives + .30 towers + .20 gd15 | .35 towers + .35 cspm + .30 objectives | .45 objectives + .35 towers + .20 wcpm |
| `vision` | .50 vspm + .30 wpm + .20 wcpm | .40 vspm + .25 wpm + .35 wcpm | .50 vspm + .30 wpm + .20 wcpm | .40 vspm + .25 wpm + .20 wcpm + .15 ctrl_wards |
| `consistency` | inverse stddev of composite, blended .70 with `min(1, weighted_games/40)` | same | same | same |

The `consistency` blend with game volume is intentional: a player with 18 games has not
*demonstrated* consistency, whatever their variance looks like.

### 6.3 OVR

```
rawOvr = sum(subStat * roleWeight[role][subStat])
```

| Role | laning | teamfight | mechanics | macro | vision | consistency |
|---|---|---|---|---|---|---|
| TOP | .26 | .24 | .22 | .16 | .04 | .08 |
| JNG | .12 | .22 | .20 | .30 | .08 | .08 |
| MID | .24 | .28 | .22 | .14 | .04 | .08 |
| BOT | .24 | .34 | .22 | .10 | .02 | .08 |
| SUP | .14 | .22 | .14 | .20 | .22 | .08 |

Then an **accolade bonus** from S2, capped at +4:

| Accolade (that season) | Bonus |
|---|---|
| Won Worlds | +3.0 |
| Worlds finalist / MSI winner | +2.0 |
| Domestic title | +1.0 |
| Season or finals MVP | +1.5 |

Finally, `rawOvr + accolade` is **percentile-mapped onto the target 40-99 distribution** so the
catalogue always matches the rarity shares in [02 section 3](02-cards-and-collection.md).
Percentile mapping, not clamping, is what keeps the bands stable as new years are added.

### 6.4 Validation gate

The rate stage fails loudly if any of these hold:

- More than 2.5% of cards land at an OVR boundary (sign of clamping instead of mapping).
- Any cohort has fewer than 20 members (z-scores meaningless — merge into an adjacent year).
- The known-good anchor set drifts: a `config/anchors.json` lists ~30 player-seasons with an
  expected OVR band (e.g. `faker-2016` in 93-99, a mid-table minor-region support in 55-70).
  Anchors are a smoke test for the whole chain, not a design input.

## 7. Stage 5 — Champion pools

For each `(player_uid, season_year)`, group their games by `champion`:

```
base      = 100 * games / (games + 6)              # 6 games -> 50, 12 -> 67, 30 -> 83
wrAdj     = (winrate - 0.50) * 40                  # +/-20 at the extremes
perfAdj   = clamp(z(composite_on_champ vs own season mean) * 8, -12, +12)
mastery   = round(clamp(base + wrAdj + perfAdj, 10, 100))
```

Keep the top 15 by games. Any champion with `games >= 2` qualifies; one-off picks are dropped
as noise. Every champion the player actually played gets at least mastery 10, which is still
far below the useful threshold — it reads as "has played it once" rather than "can play it".

`roleFit` for [02 section 2.4](02-cards-and-collection.md) comes from the same aggregate: a
champion is **flex** in role R for a year if `>= 10%` of that year's professional games on that
champion were played in role R.

## 8. Stage 6 — Mint, assets and legal

### 8.1 Minting
Writes `card_definitions` rows: identity, ratings, pool, rarity band, accolades, and a
`provenance` JSON blob recording source file hashes, game counts and the pipeline version.
The provenance blob is surfaced on the card back ([02 section 6](02-cards-and-collection.md)).

### 8.2 Assets — the risk area

| Asset | Plan | Fallback if blocked |
|---|---|---|
| Champion icons/splash | Data Dragon / Community Dragon, cached into Supabase Storage | None needed; this is the intended use |
| Team logos | Leaguepedia, per-file licence check | Generated monogram tile in team colours |
| **Player portraits** | Leaguepedia, per-file licence check, attribution stored per image | **Generated silhouette/initials avatar.** This is the default until a specific image is cleared |

**Player portraits default to the fallback.** Photographs of real people carry both copyright
and personality-rights exposure, and neither is solved by a CC BY-SA text licence on the wiki
page. A portrait is only used when its specific file's licence has been recorded in
`asset_licences` with the attribution string that will be rendered. Build the game so it looks
good with generated avatars; treat real portraits as a bonus.

### 8.3 Name and likeness
Player handles, team names and statistics are facts and are used as facts, with attribution.
The game is non-commercial. If it ever monetises, this section has to be revisited with actual
legal advice — that is the trigger condition, written down here so it is not forgotten.

### 8.4 Riot
The project follows Riot's Legal Jibber Jabber policy for community projects: free to play,
clearly not endorsed by Riot, a disclaimer in the footer and the about screen. Riot IP
(champion names, icons, the Rift map) is used only in that frame.

## 9. Stage 7 — Publish and versioning

The catalogue is **immutable once published**.

```
catalogue_versions(id, semver, built_at, pipeline_git_sha, source_hashes, card_count, status)
status: building -> validated -> live -> archived
```

- A league **pins a `catalogue_version` at season start**. Re-running the pipeline and getting
  slightly different OVRs never changes a card mid-season. This is non-negotiable: a card that
  silently gets worse overnight destroys trust in the whole collection.
- `manager_cards` stores `card_key` **and** `catalogue_version_id`. When a league starts a new
  season on a newer catalogue, owned cards are migrated by `card_key`, and the migration diff
  (OVR deltas) is shown to the manager in a changelog screen.
- Cards that disappear from a newer catalogue (e.g. a player-season that fell below the
  inclusion threshold after a data correction) are **retained as legacy cards** pinned to their
  original version. Nothing is ever taken out of a collection.

## 10. Scheduling and operations

| Job | Cadence | Notes |
|---|---|---|
| Incremental OE ingest (current year) | Weekly, Tuesday 06:00 UTC | Current-season data changes as splits progress |
| Full historical rebuild | On demand | After a formula change or a column-map fix |
| Leaguepedia metadata refresh | Monthly | Identity and accolades move slowly |
| Data Dragon patch sync | Weekly | New champions, new icons |
| Catalogue publish | Manual approval | A human reviews the anchor-set diff before `status -> live` |

Runs are executed as a GitHub Action (or any container runner) with the Supabase service-role
key, never from the browser or the Nitro server. Each run writes a `pipeline_runs` row with
stage timings, row counts and the validation report.

**Local development** uses a committed `fixtures/mini-catalogue.json` of ~120 cards so the app
is runnable without downloading 1 GB of CSVs.

## 11. What must be verified before implementation

1. Oracle's Elixir current terms of use, and whether this project counts as non-commercial
   under them. Email the maintainer; get it in writing. **If refused:** fall back to building
   aggregates from Leaguepedia `ScoreboardPlayers` via Cargo, which is CC BY-SA but far more
   work and has thinner columns (no `golddiffat15` for older years).
2. Leaguepedia's API etiquette limits and whether a cached mirror is acceptable.
3. Per-file licence of any player portrait before it ships.
4. That Riot's current policy still permits this category of community project.

## 12. Open questions

- **Season coverage for v1.** All years since 2014 (~8-12k cards) or a curated window, e.g.
  2018-2025 plus a hand-picked "Classics" set? A smaller catalogue makes drops feel meaningful
  and cuts pipeline work. Leaning toward 2018+ plus ~150 classics.
- **Minor regions.** Including every minor league triples the catalogue with cards nobody
  recognises. Possibly ingest them but exclude from drop tables.
- **Patch-era normalisation.** Cohorting by year handles meta drift roughly; cohorting by
  patch-era (preseason boundaries) would be more precise and more complex.
- **Do accolades belong in OVR at all,** or should they only drive rarity? Putting them in OVR
  mixes narrative into a measured number.
