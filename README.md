# LOM — League of Managers

A mobile-first web game where 2–6 friends run a private league of League of Legends teams
built from collectible **player-season cards** (Faker 2024, Faker 2026, Chovy 2023 …),
draft champions onto those players in a live ban/pick, and watch a simulated match play out
on an animated Summoner's Rift.

**Status:** deployable. Accounts, a daily pack at 17:00, a collection, a roster, the live
ban/pick draft and the match simulation are all built — two managers can duel end to end.
Leagues work: you host one, invite people with a link, the whole season's fixture list is
generated when the owner starts the season, and those fixtures are played in the draft room
and scored into a table. A finished match pays Credits and card XP, and the sponsors you have
signed pay alongside it. Playoffs, season placings and forfeits for a no-show are still
specification.

## Running it

```bash
npm install
cp .env.example .env     # fill in your Supabase keys
npm run dev              # http://localhost:3000
```

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor** → run every file in `supabase/migrations/` in order, starting with
   `0001_init.sql`. They are forward-only and safe to re-run. Between them they create the
   catalogue, collection and pack tables, the row-level security policies, the trigger that
   gives every new account a profile and a welcome pack, and — in `0008_pack_gifts.sql` —
   that same welcome pack for every account that already exists. `0009_leagues.sql` adds
   leagues, membership and the fixture list, and `0010_league_fixtures_playable.sql` lets a
   fixture open a draft room and keep its result; without them the League tab loads nothing.
   `0011_match_rewards.sql` makes a finished match pay, and `0012_sponsors.sql` adds the
   sponsor book — without them matches pay nothing and the Sponsors tab loads nothing.
   `0013_playoffs.sql` gives a season an end: the two playoff stages, a champion on the
   league, and the ledger the placings are paid through. Without it the last regular fixture
   of a season is the last thing that happens. `0014_season_reset.sql` lets a league be
   played again — a season column on the fixtures, the honours board, and the Season pack.
3. **Authentication → Providers → Email**: on, and turn **Confirm email off**. Signing up
   then signs you straight in. The built-in SMTP is capped at a few messages an hour, so a
   confirmation step on a friends-only league buys nothing and gives `email rate limit
   exceeded` the moment you test signup twice. The app expects a session back from
   `signUp` and explains itself if the setting is still on.
4. **Authentication → URL Configuration**: set the Site URL to your Vercel domain, and put
   both `https://<your-domain>/**` and `http://localhost:3000/**` on the Redirect URLs
   allow-list. Password resets go through those, and anything not on the list falls back to
   the Site URL — which is how a link ends up pointing at localhost.
5. **Project Settings → API**: copy the Project URL, the `anon` key and the `service_role`
   key into `.env`.

### 2. Load a catalogue

The app needs cards before a pack can roll. Two ways in:

```bash
# a) the seed: 177 famous player-seasons, editorial ratings, instant
npm run catalogue:build
SUPABASE_URL=... SUPABASE_SERVICE_KEY=... npm run catalogue:push

# b) the real thing: computed from Leaguepedia match data
npm run ingest -- --years 2023..2025 --leagues LCK,LEC,LCS,LPL
SUPABASE_URL=... SUPABASE_SERVICE_KEY=... npm run catalogue:push
```

`data/catalogue.json` is a build artifact and is not committed — both producers regenerate
it in one command, and the copy that matters is the one in Supabase.

For the whole history, run it a year at a time so each season is normalised against its own
cohort rather than against every era at once:

```bash
scripts/ingest-all.sh 2013 2026          # resumable; skips years already done
node scripts/merge-catalogues.mjs        # .data/years/*.json -> data/catalogue.json
SUPABASE_URL=... SUPABASE_SERVICE_KEY=... npm run catalogue:push
```

The ingest walks every official Primary tournament for those years, aggregates each
player-season, and maps role-cohort percentiles onto the band shares in
[docs/02](docs/02-cards-and-collection.md). It is deliberately slow — Leaguepedia rate-limits
and the correct response to that is to wait, not to retry harder. Responses are cached under
`.data/`, so a re-run is cheap. `--all-leagues` takes in every region.

Ratings only mean something against a large cohort: with one league and one year you will
get a warning, and the top of each band will be compressed.

### 3. Vercel

Import the repository; Nuxt is detected with no build configuration. Set these environment
variables for **Production, Preview and Development**:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_KEY` | `anon` public key |
| `SUPABASE_SERVICE_KEY` | `service_role` key — server only, never exposed to the browser |
| `NUXT_PACK_HOUR` | `17` |
| `NUXT_PACK_TZ` | `Europe/Paris` |

Deploy. Then set the Supabase Site URL to the deployed domain so email links come back to
the right place.

### How the daily pack works

A pack day runs 17:00 → 17:00 in `NUXT_PACK_TZ`, so "today's pack" is the window that opened
at the last 17:00 rather than at midnight. The claim is one row with a unique
`(profile_id, pack_day)` index: two taps race on the insert and exactly one wins. The roll
runs server-side with the service-role key, and there is deliberately no client-side insert
policy on `collection_cards` — without that, a manager could grant themselves Faker.

Rarity odds, pity counters and the thinnest-role bias are
[docs/02 section 5](docs/02-cards-and-collection.md). Pity is shown in the UI on purpose:
hidden pity is just anxiety.

### How a league works

One manager hosts: a name, a timezone and a match hour. The app mints a six-character
invite code, and `/join/<code>` is a link that can be dropped in a group chat — it shows
whose league it is and who is already in before it asks anyone to commit, and it survives
signing up, so somebody with no account lands back on the invite rather than on the pack
screen.

Pressing **Start season** is the lock. It closes the invite, pins the catalogue, and writes
every fixture of the season in one go: everyone against everyone twice, once from each side
of the draft, about ten match evenings with a rest day in the middle, each at the league's
match hour in the league's own timezone. An odd number of managers leaves somebody unpaired
each round, and they get a Ghost fixture rather than a night off. The schedule is visible as
a preview while the league forms, so the owner can see what they are committing five other
people to.

**Playing a fixture** happens in the duel room. Fifteen minutes before kick-off the fixture
grows a button; whoever taps it first opens the room and the other manager's Battle tab
lights up. The sides are the ones the schedule assigned — nothing is drawn, which is what
makes the second cycle's swap worth anything — and the draft, the clock and the engine are
the same ones a friendly uses. An odd league's spare manager plays the agent instead of
sitting out.

The result lands on the fixture the moment the engine runs, not when somebody finishes
watching: [docs/01 section 8](docs/01-game-loop.md) is explicit that standings must not wait
on a manager who will not open the app. The table is three points a win, then head-to-head
*within the tied group* (a three-way cycle cannot be resolved pair by pair), then closing
wins quickly, then kills, then a coin seeded from the league id so a drawn table never
reshuffles itself. Ghost fixtures are played and rewatchable but do not count.

### How a season ends

The bracket is drawn the moment the last regular fixture is decided — on the server, in the
same call that writes the result, because a season that waits on somebody opening the app is
a season that can be held hostage. Top four off the final table: first plays fourth, second
plays third, a day off, then the final, all of them ordinary fixtures played in the same duel
room as everything else. The higher seed drafts first in every round, which is the one place
in the calendar where side assignment is earned rather than rotated. A league of three gives
its top seed a bye straight to the final; a league of two just plays the final.

Winning the final sets the league FINISHED with a champion on it and pays the placings: 1500
/ 900 / 500 / 250 for first, second, the two beaten semi-finalists, and everybody else. Who
finished where comes from the bracket rather than the table, so a first seed that loses the
final is paid as the runner-up — which is what it is. One `season_rewards` row per manager
per season, claimed before a single Credit moves, so a season that settles twice pays once.
Collections are kept in full; nothing is wiped and card levels persist.

And then the owner gets a **Start season 2** button. Nothing is reset by it, whatever the
word suggests: a fixture belongs to a season, so season 1 keeps its calendar, its results,
its replays, its standings and its payouts, and season 2 begins beside it. The table looks
empty because it is asking a different question. Past champions go on an honours board that
outlives any one season, and everybody who saw a season out is handed a **Season pack** — one
card, Epic at worst — when the final is decided, whether or not anyone starts another.

Two things are deliberately not there yet. **No forfeits** — a fixture nobody opens stays
scheduled, and its button keeps working tomorrow, because a league of friends misses evenings
and a missed evening is a worse game than a forfeit nobody chose; real absence handling is
[docs/05 section 7](docs/05-draft-and-live-session.md). And **a league does not own cards**:
[docs/07](docs/07-data-model.md) gives each membership its own collection, while here a
manager brings the one collection they have — noted in
`supabase/migrations/0009_leagues.sql`, which is also where the schema for the per-league
version is already laid out.

### How a match pays

Finishing a match writes one `match_rewards` row per manager and pays against it: 50 Credits
for playing, 100 more for winning, 25 per starter who graded S, 200 for the first win of a
league season, and card XP to the five who played. The receipt is stored on that row, and the
result screen renders it rather than recomputing it — a screen that worked the numbers out
for itself could disagree with the ledger, and the ledger is what the Credits pill counts.

A Ghost pays half of all of it, and past three paid Ghost matches in a pack-day it pays card
XP and no Credits: the Ghost in the spec is the bye in an odd league, one a day, but a bot
duel can be started on demand and an unbounded Ghost is a faucet with a tap on it.

**Sponsors** pay alongside. A contract is an appearance fee that always pays plus a bonus that
only pays when the five you fielded met its demand — three starters from the LCK, nobody above
Epic, win inside half an hour. Two slots, a three-match term, and a buy-out if you want out
early. The whole point is that the bonus is a reason to build one way rather than another;
[docs/12](docs/12-sponsors.md) is the spec, including the demands that were deliberately left
out.

## Layout

| Path | What it is |
|---|---|
| `app/` | Nuxt 4 app — pages, components, the design system in `assets/css/main.css` |
| `server/api/league/` | Hosting, joining, launching a season, playing a fixture, reading a leaguemate's squad |
| `server/api/pack/` | Pack status and claim, the only writers of a collection |
| `server/api/sponsors/` | The sponsor book, signing, releasing, and the sponsor meeting |
| `server/api/gifts/` | Packs a manager has been given, and opening them |
| `server/utils/` | The pack window, the roll |
| `shared/` | Row → card mapping, draft order, the league invite code and schedule, what a match pays and what a sponsor demands — all used by both sides |
| `supabase/migrations/` | Forward-only SQL |
| `scripts/` | Catalogue build, catalogue push, Leaguepedia ingest |
| `data/` | The seed roster and the built catalogue |
| `packages/card-engine/` | The card renderer and the pack-opening sequence |
| `docs/` | The specification |

## Pillars

1. **Cards are real people in a real season.** Every stat on a card is derived from actual
   pro play data, not invented. Faker 2024 and Faker 2026 are different cards with different
   champion pools and different numbers.
2. **The collection feeds the draft.** Champion mastery on your cards is what makes a pick
   good. A 92 OVR mid on a champion he never played is worse than an 84 OVR mid on his main.
3. **One match a day, live, together.** The league meets at a fixed hour. Draft takes ~6
   minutes, the replay takes ~4. Ten minutes a day.
4. **v1 is a game, not a spreadsheet.** Management depth (transfers, contracts, training,
   finances, scouting) is layered on after the core loop is fun.

## Decisions locked for v1

| Area | Decision | Spec |
|---|---|---|
| Client | Nuxt 4 PWA (Vue 3, TypeScript), mobile-first | [06](docs/06-architecture.md) |
| Hosting | Vercel (Nitro), Supabase for Postgres + Auth | [06](docs/06-architecture.md) |
| Daily pack | One card, 17:00 in the league timezone, pity visible | [02](docs/02-cards-and-collection.md) |
| Backend | Nuxt Nitro server routes + Supabase (Postgres, Auth, Realtime, Storage) | [06](docs/06-architecture.md) |
| Sim engine | `@lom/sim` shared TS package, deterministic, seeded PRNG | [04](docs/04-simulation-engine.md) |
| Player data | Automated ingestion pipeline (Oracle's Elixir + Leaguepedia + Data Dragon) | [03](docs/03-data-pipeline.md) |
| Match format | Live synchronous draft + replay, with hard timeouts and auto-draft fallback | [05](docs/05-draft-and-live-session.md) |

## Spec index

| # | Document | What it answers |
|---|---|---|
| 00 | [Vision & scope](docs/00-vision-and-scope.md) | What the game is, what v1 includes and excludes |
| 01 | [Game loop](docs/01-game-loop.md) | The daily cycle, the season, standings, rewards |
| 02 | [Cards & collection](docs/02-cards-and-collection.md) | Card anatomy, rarity, packs, drop tables, duplicates |
| 03 | [Data pipeline](docs/03-data-pipeline.md) | Where real data comes from, how it becomes a card |
| 04 | [Simulation engine](docs/04-simulation-engine.md) | How a match is computed and turned into events |
| 05 | [Draft & live session](docs/05-draft-and-live-session.md) | Ban/pick rules, timers, presence, no-show handling |
| 06 | [Architecture](docs/06-architecture.md) | Stack, deployment, module boundaries, scaling limits |
| 07 | [Data model](docs/07-data-model.md) | Postgres schema, RLS policies |
| 08 | [API & realtime](docs/08-api-and-realtime.md) | Endpoints, channel protocol, message shapes |
| 09 | [Screens](docs/09-screens.md) | Every screen in v1, mobile-first |
| 10 | [Roadmap](docs/10-roadmap.md) | Build order for v1, then the management layer |
| 11 | [Card assets & caching](docs/11-card-assets-and-caching.md) | Art derivatives, the catalogue bundle, what makes a preview open instantly |
| 12 | [Sponsors](docs/12-sponsors.md) | Contracts, demands, slots and terms, and what a match pays |

## Open questions tracked

See the "Open questions" section at the end of each spec. Nothing in these documents is
final until it has survived a playtest.
