# LOM — League of Managers

A mobile-first web game where 2–6 friends run a private league of League of Legends teams
built from collectible **player-season cards** (Faker 2024, Faker 2026, Chovy 2023 …),
draft champions onto those players in a live ban/pick, and watch a simulated match play out
on an animated Summoner's Rift.

**Status:** v1 of the collection loop is built and deployable — accounts, a daily pack at
17:00, and a collection. The league, draft and match simulation are still specification.

## Running it

```bash
npm install
cp .env.example .env     # fill in your Supabase keys
npm run dev              # http://localhost:3000
```

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor** → paste `supabase/migrations/0001_init.sql` → Run. That creates the
   catalogue, collection and pack tables, the row-level security policies, and the trigger
   that gives every new account a profile.
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

## Layout

| Path | What it is |
|---|---|
| `app/` | Nuxt 4 app — pages, components, the design system in `assets/css/main.css` |
| `server/api/pack/` | Pack status and claim, the only writers of a collection |
| `server/utils/` | The pack window, the roll |
| `shared/` | Row → card mapping used by both sides |
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

## Open questions tracked

See the "Open questions" section at the end of each spec. Nothing in these documents is
final until it has survived a playtest.
