# 06 — Architecture

## 1. Stack

| Layer | Choice | Notes |
|---|---|---|
| Client | **Nuxt 4** (Vue 3, `<script setup>`, TypeScript strict) | Mobile-first PWA, installable, offline shell |
| Styling | Tailwind CSS + a small in-house component set | No heavy UI kit; the game needs custom surfaces anyway |
| Client state | Pinia | Stores: `session`, `league`, `collection`, `draft`, `replay` |
| Server | **Nitro** server routes inside the same Nuxt app | Hosts the API, the `DraftRoom`, and the sim invocation |
| Database | **Supabase Postgres 15** | RLS on every table |
| Auth | **Supabase Auth** — Discord OAuth, Google OAuth, email magic link | Discord first: this is a friend-group product |
| Realtime | **Supabase Realtime** — broadcast + presence | Draft channel, league notifications |
| Storage | **Supabase Storage** | Card art, champion assets, raw pipeline files |
| Sim | `@lom/sim`, pure TS | Server-only execution |
| Pipeline | `@lom/data-pipeline`, Node CLI | Runs in CI, not in the app |

## 2. Monorepo layout

```
LOM/
  apps/
    web/                     Nuxt app (client + Nitro server routes)
      app/
        components/
        composables/
        pages/
        stores/
      server/
        api/                 REST endpoints
        draft/               DraftRoom, timer sweeper
        utils/               supabase admin client, auth guards
      public/
  packages/
    core/                    shared domain types + pure formulas
    sim/                     @lom/sim, deterministic engine
    data-pipeline/           ingest -> publish CLI
    db/                      SQL migrations, seed, generated types
  docs/                      these specs
  fixtures/                  mini-catalogue for local dev
```

`packages/core` is the keystone: `effRating`, `masteryFactor`, `chemistry`, rarity bands, and
all shared types live there so the pipeline, the sim and the UI can never disagree about what
a card's rating means.

Dependency rule, enforced by `eslint-plugin-boundaries`:

```
web -> core, sim, db
sim -> core
data-pipeline -> core, db
core -> (nothing)
```

## 3. Runtime topology

```
        ┌─────────────────────────────┐
        │  Browser (Nuxt PWA)         │
        │  - collection, lineup       │
        │  - draft UI                 │
        │  - replay renderer (Canvas) │
        └───┬──────────────────┬──────┘
            │ HTTPS            │ WSS (realtime + presence)
            │                  │
    ┌───────▼──────────┐   ┌───▼──────────────────────┐
    │ Nitro server     │   │ Supabase Realtime        │
    │  - /api/*        │   └───▲──────────────────────┘
    │  - DraftRoom     │       │ broadcast
    │  - @lom/sim      │───────┘
    │  - service key   │
    └───────┬──────────┘
            │ postgres
    ┌───────▼──────────────────────────────────────┐
    │ Supabase: Postgres + Auth + Storage          │
    └───────▲──────────────────────────────────────┘
            │ service key, scheduled
    ┌───────┴──────────┐
    │ GitHub Actions   │  data pipeline runs
    └──────────────────┘
```

The client talks to Supabase directly **only** for auth and for realtime subscribe/presence.
All game state mutation goes through Nitro. This keeps authority in one place and keeps the
RLS policies simple (read-mostly for the client).

## 4. Deployment

| Component | Target | Config |
|---|---|---|
| Nuxt + Nitro | Fly.io or Railway, Node preset | **`replicas: 1`** — required, see [05 section 5.1](05-draft-and-live-session.md) |
| Postgres / Auth / Storage / Realtime | Supabase cloud | Free tier is sufficient for a handful of leagues |
| Data pipeline | GitHub Actions, scheduled | Service-role key in repo secrets |
| Static assets | Supabase Storage + CDN | Champion art cached at build/sync time |

A startup assertion registers the instance in a `server_instances` table and **throws if
another live instance exists**, so the single-instance constraint fails loudly rather than
silently corrupting a draft.

**Environments:** `local` (Supabase CLI, Docker, mini-catalogue), `staging`, `production`.
Migrations run via `supabase db push` in CI, forward-only.

## 5. Module responsibilities

### 5.1 `packages/core`
Pure, dependency-free. Types (`Card`, `Lineup`, `Fixture`, `DraftState`, `SimEvent`), and
the shared formulas: `masteryFactor`, `roleFit`, `effRating`, `chemistryFor`, `rarityForOvr`,
`gradeFor`. 100% unit-tested; it is the one place a balance change can silently propagate.

### 5.2 `packages/sim`
See [04](04-simulation-engine.md). No imports beyond `core`. Exports `simulate()` and the
`BALANCE` constant object.

### 5.3 `apps/web/server`
- `api/` — REST handlers, each one: authenticate -> authorise -> validate (Zod) -> act -> DTO.
- `draft/DraftRoom.ts` — the in-memory authoritative draft state machine, the timer, and the
  broadcast publisher.
- `draft/sweeper.ts` — a 10-second interval that resolves expired deadlines across all rooms.
- `jobs/` — day-roll (pack entitlements, fixture state transitions), run by a 1-minute interval
  that checks each league's local midnight and match hour. A single instance makes this safe
  without distributed locking; the job is also written to be idempotent.

### 5.4 `apps/web/app`
Pages are thin. All game logic that the client needs (comp modifier preview, effRating display,
mastery bars) comes from `@lom/core` so the numbers on screen are the same numbers the sim uses.

## 6. The replay renderer

The one genuinely custom piece of front-end engineering.

- **Canvas 2D**, not SVG and not WebGL. Ten moving dots, a static map image, and some
  particles. Canvas 2D at 30 fps is comfortably enough on a mid-range phone and avoids a
  rendering library dependency.
- Input: the `SimEvent[]` log plus the lane anchors from `@lom/sim/map`.
- A **`ReplayClock`** maps wall time to game time at the current speed multiplier; a
  **`ReplayState`** is derived by folding events up to the current game time.
- Champion positions are interpolated between the last and next event that mention each
  player, falling back to lane/grouping anchors. Movement uses a cubic ease so dots do not
  teleport.
- Layers, back to front: map image -> structures -> ward dots -> champion dots -> kill
  markers/particles -> objective banners.
- Above the canvas (DOM, not canvas): scoreboard, gold-difference sparkline, event ticker with
  the pre-rendered `narration` strings, timeline scrubber.
- Scrubbing re-folds from `t = 0` (fast: at most a few thousand events) rather than keeping
  reversible state.

Accessibility: the event ticker is a complete textual account of the match, so the replay is
fully consumable without the animation. Honour `prefers-reduced-motion` by defaulting to the
ticker view.

## 7. Performance budget

| Metric | Budget |
|---|---|
| First contentful paint, 4G mid-range phone | < 1.8 s |
| JS shipped on the first route | < 180 KB gzipped |
| Draft action round trip (p95) | < 250 ms |
| Replay frame time | < 16 ms at 30 fps on a 2021 mid-range Android |
| `simulate()` p99 | < 50 ms |
| Collection screen with 400 cards | 60 fps scroll (virtualised list) |

Card art is served as WebP/AVIF at three sizes. The champion grid preloads only the icons for
the lineup's pools; everything else is lazy.

## 8. Security

- **Service-role key never leaves the server.** The client uses the anon key, which is subject
  to RLS.
- **RLS on every table**, including read paths; the client can read only its own manager rows
  and the leagues it belongs to. See [07 section 4](07-data-model.md).
- All API input validated with Zod at the boundary; no raw body reaches a query.
- Rate limiting on `POST /api/draft/action` (20/10 s per manager) and on league join.
- The sim and its inputs are server-only. The client receives event logs, never a way to
  recompute or forge one.
- Hidden-state filtering happens in a dedicated DTO mapper with its own tests
  ([05 section 6](05-draft-and-live-session.md)), not ad hoc in handlers.

## 9. Observability

| Concern | Tool |
|---|---|
| Errors | Sentry (client + server), with `fixtureId` and `simVersion` as tags |
| Structured logs | `pino` to stdout, shipped by the host |
| Draft health | A counter per fixture: actions, timer expiries, reconnects, auto-drafts. Surfaced on an internal `/admin/health` page |
| Sim health | Every `simulate()` logs duration and game length; a rolling histogram catches balance drift in production |
| Pipeline | `pipeline_runs` table with stage timings, row counts and the validation report |

**The one alert that matters:** a fixture stuck in `drafting` or `simulating` for more than
10 minutes. That is the failure mode that ruins someone's evening.

## 10. Why not the alternatives

| Rejected | Reason |
|---|---|
| Supabase Edge Functions for the draft | No long-lived in-memory state; every timer would need `pg_cron`, which has 1-minute granularity against a 30-second timer |
| Realtime-only architecture (no Nitro) | The sim must not run on the client, and draft authority must not live in the database alone |
| WebSocket server of our own | Supabase Realtime is already in the stack and already handles auth, presence and reconnection |
| React Native | A PWA covers a daily 10-minute session; app-store review would slow a playtest loop that needs daily iteration |
| WebGL replay | Ten dots. Canvas 2D is the right size of tool |

## 11. Open questions

- **Will the free Supabase tier's realtime limits hold** with 6 managers x several leagues
  drafting at the same hour? Measure early; it is a cheap upgrade if not.
- **Day-roll job at league-local midnight** across many timezones — a 1-minute polling loop is
  simple but imprecise. `pg_cron` per league is the alternative.
- **Single instance** is a real availability risk (a deploy during a draft kills it). Consider
  draining: refuse new drafts during the last 5 minutes before a deploy window, and schedule
  deploys away from common match hours.
