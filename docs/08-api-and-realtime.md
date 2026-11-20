# 08 — API & Realtime Protocol

All endpoints are Nitro routes under `apps/web/server/api`. JSON in, JSON out. Auth via the
Supabase JWT in `Authorization: Bearer`. Every handler follows the same four steps:
**authenticate -> authorise -> validate (Zod) -> act**, and returns a DTO built by an explicit
mapper, never a raw database row.

## 1. Conventions

- Errors: `{ error: { code, message, details? } }` with codes from a closed enum
  (`UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION`, `CONFLICT`, `RATE_LIMITED`,
  `NOT_YOUR_TURN`, `DEADLINE_PASSED`, `ILLEGAL_ACTION`, `INTERNAL`).
- Mutations that can be retried carry an `Idempotency-Key` header; the server stores the key
  for 24 h and replays the original response. Required on pack claim, league join, purchase.
- Timestamps are ISO 8601 UTC. The client converts to league-local for display.
- `GET` responses include `serverTime` so the client can measure its clock offset — used by
  every countdown in the UI.

## 2. Auth & profile

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/profile` | Create profile after first sign-in (`handle`, `displayName`) |
| `GET` | `/api/profile/me` | Profile + the leagues it belongs to + today's fixtures across them |
| `PATCH` | `/api/profile/me` | Update display name, avatar |

Sign-in itself is handled by the Supabase client SDK (Discord/Google OAuth, email magic link);
the server never sees a password.

## 3. Leagues

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/leagues` | Create. Body: name, timezone, matchHour, seasonLengthDays, teamName |
| `POST` | `/api/leagues/join` | Join by `inviteCode` + `teamName` |
| `GET` | `/api/leagues/:id` | League, members, current season, standings, next fixture |
| `POST` | `/api/leagues/:id/start` | Owner only. Locks membership, generates fixtures, grants starter squads |
| `POST` | `/api/leagues/:id/pause` | Owner only. `{ days: 1..7 }`, shifts remaining fixtures |
| `GET` | `/api/leagues/:id/schedule` | All fixtures with status and results |
| `GET` | `/api/leagues/:id/standings` | Ordered table with full tiebreak detail |

`POST /api/leagues/:id/start` is the heaviest write in the app — fixtures, starter squads, pity
counters, day-1 pack entitlements — and runs inside one transaction with the league row locked
`FOR UPDATE`. It is idempotent on `status != 'forming'`.

## 4. Collection

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/leagues/:id/collection` | Paginated cards with filters: `role`, `rarity`, `region`, `season`, `champion`, `q`, `sort` |
| `GET` | `/api/leagues/:id/collection/:cardId` | Full card detail: pool, sub-stats, season summary, provenance |
| `GET` | `/api/leagues/:id/items` | Mastery tokens and coach cards |
| `POST` | `/api/leagues/:id/items/:itemId/use` | Apply a mastery token. Body: `{ managerCardId, championKey }` |

## 5. Packs

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/leagues/:id/packs` | Unclaimed entitlements, pity counters, purchase availability |
| `POST` | `/api/leagues/:id/packs/:entitlementId/claim` | Roll and claim. **Idempotency-Key required** |
| `POST` | `/api/leagues/:id/packs/purchase` | Spend 300 credits for an entitlement |
| `POST` | `/api/leagues/:id/packs/:entitlementId/reroll` | 150 credits, once per entitlement, before claim |

The roll happens **server-side at claim time**, seeded by
`hash(entitlementId, leagueMemberId)`, and the outcome is persisted to
`pack_entitlements.result` in the same transaction that creates the card. A client that
refreshes mid-reveal gets the same card. The reveal animation is pure presentation over an
already-decided result.

## 6. Lineup

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/fixtures/:id/lineup` | Your lineup (prefilled from yesterday), plus eligible cards per slot |
| `PUT` | `/api/fixtures/:id/lineup` | Set slots, strategy, coach. Rejected after `scheduledAt - 30s` |
| `GET` | `/api/fixtures/:id/scouting` | Opponent's last 3 matches and their *last used* lineup's pools |

`GET /api/fixtures/:id/lineup` also returns a **chemistry preview** computed by `@lom/core`, so
the number on the lineup screen is provably the number the sim will use.

## 6b. Matchmaking (shipped: duel rooms)

Pairing for duels, which exist before leagues do. See
[05 section 0](05-draft-and-live-session.md) for the room these open.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/duel/queue/join` | Press Battle. Returns `{ duelId }` if it paired, `{ searching: true, waiting }` if not. Also the heartbeat: re-posting refreshes the claim without losing queue position |
| `POST` | `/api/duel/queue/leave` | Stop searching. Unconditional — a Cancel button that sometimes does not cancel is worse than a no-op |
| `GET` | `/api/duel/queue/status` | Resync for the Battle screen. Not in the fast path |
| `POST` | `/api/duel/queue/bot` | Take the agent instead, offered after ~20 s of an empty queue |
| `POST` | `/api/duel/challenge` | Friendly: challenge a named manager (the pre-queue path, kept) |
| `POST` | `/api/duel/respond` | Accept or decline a friendly |

The pairing itself is **not** in a route. It is `duel_matchmake(profile, lineup, catalogue, …)`,
a `security definer` function whose one interesting line is
`select … from duel_queue where duel_id is null order by joined_at limit 1 for update skip locked`.
That is the whole answer to two people pressing Battle in the same instant: whichever
transaction reaches a waiting row first owns it, the other does not block and does not see it,
finds nothing, and returns having been paired by the winner — which it learns by reading its
own row. The lineup snapshot is frozen onto the queue row at join so the duel can be created
complete inside that one transaction.

## 7. Draft

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/duel/:id` | Full authoritative state, filtered for the caller. **Resync only** — the steady state is a push |
| `POST` | `/api/duel/:id/action` | Submit a ban or pick |
| `POST` | `/api/duel/:id/nudge` | "A clock in here has run out — go and look." Replaces polling; see below |
| `POST` | `/api/duel/:id/auto` | "Auto-draft the rest for me" *(not built)* |

Hover is **not** an endpoint any more. It is a broadcast on the room channel, client to client,
and never touches the database.

### 7.0 Why `/nudge` exists

The clock is enforced lazily: `catchUp()` resolves whatever the deadline implies, and it runs on
every read or write of a room. The first implementation got that enforcement for free, as a side
effect of a draft screen polling every 700 ms. Take the polling away and the enforcement goes
with it — the deadline passes, nothing on the server is listening, and both players sit watching
a timer at zero on a turn that will never move.

So the client keeps the one thing polling was buying and discards the rest: instead of a request
a second it sets a single timer for the exact instant something is due (the action deadline, or
the moment the agent is going to act in a bot duel) and sends one `POST /nudge` then. There is no
payload and nothing to assert — a participant asking for a room to be brought up to date can
only ever produce the state the clock already implies — so an early nudge is a no-op and a
duplicate from the other player finds the work already done. Clients back off exponentially when
a nudge changes nothing, because "already due and asking does not help" is a reachable state
(a staked bonus pool extends a deadline without moving the turn) and the naive version of this
is a hot loop.

### 7.1 State DTO

```ts
interface DraftStateDto {
  fixtureId: string;
  status: 'lobby_open' | 'drafting' | 'simulating' | 'ready' | 'final';
  you: 'BLUE' | 'RED';
  actionIndex: number;                 // 0..20
  turn: { team: 'BLUE' | 'RED'; kind: 'BAN' | 'PICK' } | null;
  deadlineAt: string | null;
  bonusMs: { blue: number; red: number };
  present: { blue: boolean; red: boolean };
  actions: DraftActionDto[];           // everything locked so far, both sides
  lineups: {
    blue: PublicLineupDto;             // cards + pools, always visible from draft start
    red:  PublicLineupDto;
  };
  yourComp: CompModifierDto;           // factors + total, YOUR SIDE ONLY
  opponentHover: string | null;
  serverTime: string;
}
```

What is deliberately **absent** from this DTO for the opponent's side: `strategy`, `coach`,
`compModifier`, and any card not in the starting five. The mapper that produces it has its own
test file asserting those fields never appear ([05 section 6](05-draft-and-live-session.md)).

### 7.2 Action

```http
POST /api/draft/:fixtureId/action
{ "actionIndex": 7, "kind": "PICK", "championKey": "Azir", "slot": "MID" }
```

`actionIndex` is a **required optimistic-concurrency token**. If it does not match the server's
current index the request is rejected with `CONFLICT` and the current state is returned. This
makes double-taps and stale clients harmless.

Server sequence, under the room lock:

1. Resolve any expired deadline first (may auto-lock a previous action).
2. Check turn, phase, index, legality.
3. Persist `draft_actions` row.
4. Advance index, compute the next deadline, update `drafts`.
5. Broadcast `ACTION_LOCKED` then `TURN_CHANGED`.
6. If `actionIndex == 20`, transition to `simulating` and enqueue the sim.

Rate limit: 20 requests / 10 s per manager.

## 8. Match & replay

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/matches/:fixtureId` | Result, box score, timeline. 404 until `status = 'ready'` |
| `GET` | `/api/matches/:fixtureId/events` | The event log. Cacheable, immutable, `Cache-Control: immutable` |
| `POST` | `/api/matches/:fixtureId/viewed` | Marks viewed; triggers `ready -> final` when both have |
| `GET` | `/api/leagues/:id/matches` | Match history, paginated |

`/events` is a separate endpoint so the replay can stream it independently of the result
summary and so it can be cached hard — the log never changes once written.

## 9. Realtime channels

All over Supabase Realtime. Clients subscribe directly with the anon key; authorisation is by
channel-name convention plus an RLS-backed `realtime.messages` policy.

### 9.1 `duel:{duelId}` — postgres changes + broadcast + presence

Three different things on one channel, and which mechanism carries what is the design:

**Postgres changes** — state. No server-published events at all.

| Subscription | Means |
|---|---|
| `UPDATE public.duels id=eq.{duelId}` | The turn moved, the clock changed, or the phase did (`DRAFTING` → `WATCHING` → `COMPLETE`). Every server write bumps `updated_at`, so this fires even when the only visible change is a cursor |
| `INSERT public.duel_actions duel_id=eq.{duelId}` | A ban or pick is final. Subscribed separately rather than inferred from the duel row, because the insert *is* the lock — it is the row whose unique indexes decide a champion is gone — and it is the event the screen animates |

There is deliberately no `ACTION_LOCKED`/`TURN_CHANGED` pair published by the server. A
broadcast describing a row can disagree with the row; a change feed from the row cannot.

**Broadcast** — the one thing that is not state:

| Event | Payload | Meaning |
|---|---|---|
| `hover` | `{ side, kind, turn, championKey, championName, slot } \| null` | The side on the clock is considering something. Client to client, never persisted, never trusted. The action log still decides what happened |

**Presence** — who is actually in the room, client-tracked, advisory only. Drives "they are
here" in the lobby and nothing else.

**Clients never trust a push as the source of truth.** Each one triggers a debounced resync
against `GET /api/duel/:id` (60 ms, because one server write can produce two pushes and a burst
at the end of the draft produces several). Worst case the UI is 2 seconds stale via the polling
fallback.

### 9.1b `queue:{profileId}` — postgres changes

| Subscription | Means |
|---|---|
| `UPDATE public.duel_queue profile_id=eq.{me}` | You have been paired; `duel_id` is the room |

Our own queue row being updated means exactly one thing, because `duel_matchmake()` sets
`duel_id` on both rows inside the pairing transaction. This push is therefore the first moment
either client could know, and it is the same moment for both of them — which is why searching
does not poll.

RLS does the authorisation: `duel_queue` is `profile_id = auth.uid()`, so the push that tells
somebody they have been paired is not visible to anyone else.

### 9.2 `league:{leagueId}` — broadcast

| Event | Meaning |
|---|---|
| `DAY_ROLLED` | New day, new pack, new fixture |
| `FIXTURE_READY` | Someone's match finished; standings may have changed |
| `MEMBER_JOINED` | Lobby update while `status = 'forming'` |
| `RESCHEDULE_REQUESTED` / `RESCHEDULE_RESOLVED` | Absence handling |
| `SEASON_FINISHED` | Champion crowned |

### 9.3 Clock discipline

Every countdown in the UI is computed as `deadlineAt - (Date.now() + clockOffset)`. Never a
local `setInterval` decrement — those drift when a mobile browser backgrounds the tab, which is
exactly when a draft timer is running.

`clockOffset` is measured from the `serverNow` on every state read, **corrected for the round
trip**: `serverNow + rtt/2 - Date.now()`. Taking `serverNow` at face value leaves each device
out by its own latency, so two phones on different connections show different numbers for the
same deadline — which is exactly what it looked like. Charging half the measured round trip puts
them within tens of milliseconds of each other.

This stopped being a nicety once two people share a clock. The same offset drives three things,
and all three are wrong together or right together:

| Rendered from | Instant |
|---|---|
| "Match found" countdown | `starts_at` |
| Action countdown | `deadline_at` |
| How far into the match we are | `(now - watch_start_at) × watch_speed` |

The last one is the shared watch, and it is the reason there is no play, pause or scrub on it:
the clock is a server instant, not a player's position in a video. Both clients compute the same
match second from the same timestamp, and every frame is a pure function of it — so a client
backgrounded for ten seconds is instantly correct on return rather than ten seconds behind.
`shared/duelRoom.ts` holds that arithmetic, and both the client's screen change and the server's
decision to close the room read the same `watchSettled()`.

## 10. Internal / admin

Not exposed to players; behind an allowlist of profile IDs.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/admin/health` | Stuck fixtures, active draft rooms, sim latency histogram |
| `POST` | `/api/admin/fixtures/:id/resim` | Re-run a crashed sim (same seed, same result) |
| `POST` | `/api/admin/fixtures/:id/void` | Last-resort escape hatch |
| `GET` | `/api/admin/pipeline/runs` | Pipeline history and validation reports |
| `POST` | `/api/admin/catalogue/:id/publish` | Flip a validated catalogue version live |

## 11. Open questions

- **Idempotency keys** are specified for three endpoints; audit whether lineup `PUT` and
  `items/use` need them too.
- **`/events` payload size** on a slow connection — consider server-side gzip plus a
  `?from=` parameter so the replay can start before the whole log arrives. More pressing now
  that the shared watch needs the whole log in hand on *both* clients before the clock starts.
- **Channel authorisation.** State now rides on postgres changes, which Realtime filters
  through RLS, so the duel and queue subscriptions are authorised by the same policies as a
  normal read. The remaining untested surface is `broadcast`: the hover event's channel name
  is convention-based, so somebody who knows a duel id could in principle subscribe and watch
  a stranger hover. Worth a test, and worth noting that the information leaked is a champion
  somebody is looking at in a game they are not in.
- **Rooms nobody is in.** Timer enforcement is lazy and nudged by the clients in the room, so
  a draft both players abandoned is only resolved when one of them next opens it — same as
  before, since the old version depended on somebody's screen polling. `pg_cron` calling a
  sweeper every 30 s would close them properly and is the obvious next step if abandoned rooms
  ever show up in the data.
- **Pairing is first-come, not matched.** `duel_matchmake()` takes the oldest waiting row and
  nothing else. There is no rating, no collection-strength band, and with a handful of players
  there should not be — but the function is where that would go, and the queue row is where
  the number would live.

*Resolved:* the polling fallback was worth building (it is the `CHANNEL_ERROR` path in
`useDuelRoom`, ~10 lines, 2 s) and the single-instance `DraftRoom` constraint is gone — see
[05 section 5.1](05-draft-and-live-session.md).
