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

## 7. Draft

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/draft/:fixtureId/state` | Full authoritative state, filtered for the caller |
| `POST` | `/api/draft/:fixtureId/action` | Submit a ban or pick |
| `POST` | `/api/draft/:fixtureId/hover` | Broadcast a hover (fire and forget, not persisted) |
| `POST` | `/api/draft/:fixtureId/auto` | "Auto-draft the rest for me" |

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

### 9.1 `draft:{fixtureId}` — broadcast + presence

Presence payload (tracked by each client):

```ts
{ memberId: string; team: 'BLUE' | 'RED'; at: string }
```

Broadcast events (published by the Nitro server only):

| Event | Payload | Meaning |
|---|---|---|
| `DRAFT_STARTED` | `{ actionIndex, turn, deadlineAt }` | Both present, or grace expired |
| `ACTION_LOCKED` | `{ action, actionIndex }` | A ban or pick is final |
| `TURN_CHANGED` | `{ actionIndex, turn, deadlineAt, bonusMs }` | Whose turn, and until when |
| `HOVER` | `{ team, championKey \| null }` | Opponent is hovering |
| `BONUS_CONSUMED` | `{ team, bonusMs }` | A timer expired into the bonus pool |
| `AUTO_ACTION` | `{ team, reason }` | The agent acted; UI shows a badge |
| `DRAFT_COMPLETE` | `{ }` | 20 actions done, simulating |
| `MATCH_READY` | `{ fixtureId }` | Event log written, replay available |

**Clients never trust broadcasts as the source of truth.** Each one triggers a local state
patch; a sequence gap or any ambiguity triggers a `GET /state` resync. Worst case the UI is
2 seconds stale via the polling fallback.

### 9.2 `league:{leagueId}` — broadcast

| Event | Meaning |
|---|---|
| `DAY_ROLLED` | New day, new pack, new fixture |
| `FIXTURE_READY` | Someone's match finished; standings may have changed |
| `MEMBER_JOINED` | Lobby update while `status = 'forming'` |
| `RESCHEDULE_REQUESTED` / `RESCHEDULE_RESOLVED` | Absence handling |
| `SEASON_FINISHED` | Champion crowned |

### 9.3 Clock discipline

Every countdown in the UI is computed as `deadlineAt - (Date.now() + clockOffset)`, where
`clockOffset` is the median of the last five `serverTime` observations. Never a local
`setInterval` decrement — those drift when a mobile browser backgrounds the tab, which is
exactly when a draft timer is running.

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

- **Is a polling fallback worth building in v1,** or is realtime reliable enough that a
  "reconnecting" banner plus manual refresh suffices? Leaning toward building it: it is ~30
  lines and it is the difference between a broken evening and a slow one.
- **Idempotency keys** are specified for three endpoints; audit whether lineup `PUT` and
  `items/use` need them too.
- **`/events` payload size** on a slow connection — consider server-side gzip plus a
  `?from=` parameter so the replay can start before the whole log arrives.
- **Channel authorisation.** Convention-based channel names plus RLS on `realtime.messages`
  needs a real test: can a league member subscribe to another league's draft channel?
