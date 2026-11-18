# 05 — Draft & Live Session

The only part of the game that requires two humans to be online at once. Everything in this
document exists to make that requirement survivable.

## 1. Timeline of a live session

| Clock | Event |
|---|---|
| `M - 15:00` | Lobby opens. Fixture -> `lobby_open`. Presence broadcast begins. Notification fires. |
| `M - 0:30` | Lineups lock. Neither manager can change cards or strategy after this. |
| `M + 0:00` | Draft starts if both present. Otherwise grace period begins. |
| `M + 1:00` | Grace expires. Absent managers are played by the auto-draft agent. |
| `M + ~6:00` | 20th action resolved. Fixture -> `simulating`. |
| `M + ~6:05` | Event log written. Fixture -> `ready`. Replay available. |

The draft **never waits indefinitely and never cancels**. A match always produces a result on
its scheduled day. This is the single most important rule in the live design: a daily league
dies the first time someone's absence blocks everyone else's evening.

## 2. What each side can see

| Information | Visible to opponent | When |
|---|---|---|
| Your starting lineup (5 cards, OVR, sub-stats) | Yes | Draft start |
| Those cards' full champion pools with mastery | Yes | Draft start |
| Your bench / rest of collection | **No** | Never (v2 scouting feature) |
| Your strategy preset | **No** | After the draft completes |
| Your coach card | **No** | After the draft completes |
| Your picks and bans | Yes | Immediately on lock |
| Your slot assignment for each pick | Yes | Immediately on lock |
| Your live composition modifier | **No** | Never — you see only your own |

Revealing lineups and pools at draft start is deliberate. Banning is only interesting when you
know what you are banning against. The hidden information that remains — strategy, coach — is
enough to keep a bluff alive without turning the draft into a guessing game.

## 3. Draft structure

Standard competitive order, 10 bans and 10 picks, 20 actions:

```
Ban  phase 1:  B1  R1  B2  R2  B3  R3
Pick phase 1:  B1  R1  R2  B2  B3  R3
Ban  phase 2:  R4  B4  R5  B5
Pick phase 2:  R4  B4  B5  R5
```

Blue side has first ban and first pick; red side has last pick. Side is assigned by the fixture
generator and swaps between round-robin cycles ([01 section 3](01-game-loop.md)).

### 3.1 Picks carry a slot

A pick is `(champion, slot)` where `slot` is one of the manager's five lineup positions, each
usable exactly once. The slot is public immediately.

A champion may be assigned to any slot. Off-role assignment is legal and costs `roleFit`
([02 section 2.4](02-cards-and-collection.md)) — a 0.72 multiplier, which is usually ruinous
but occasionally the right call when your main's champion is banned.

### 3.2 Legality

An action is legal when:
- It is that team's turn, and the action type matches the phase.
- The champion exists in the catalogue for the pinned `catalogue_version`.
- The champion is not already picked or banned in this draft.
- (Picks) The slot is not already filled.

Notably **not** a legality rule: mastery. Any card can be drafted onto any champion. The
penalty is the constraint, not a rule.

### 3.3 Timers

| Timer | Value |
|---|---|
| Per action | 30 s |
| Team bonus time pool | 60 s, consumed automatically when an action timer expires |
| Hard auto-lock | When both the action timer and the bonus pool are exhausted |

Timers are **authoritative on the server**. The client renders a countdown derived from a
server-sent `deadlineAt` plus a measured clock offset; it never decides an expiry. A client
whose timer disagrees is simply wrong, and the server's `ACTION_LOCKED` broadcast corrects it.

Hovering a champion (pre-lock) is broadcast to the opponent, as in the real client. It is the
cheapest possible source of mind games and costs nothing to implement.

## 4. Auto-draft agent

Used for: timer expiry, no-shows, Ghost matches ([01 section 6](01-game-loop.md)), and the
"Auto-draft for me" button a manager can press at any point.

Design goal: **competent, not optimal**. It should play like a reasonable friend who is not
paying full attention. If it played perfectly, nobody would show up.

### 4.1 Pick scoring

```
pickScore(champ, slot) =
      effRating(lineup[slot], champ, slot)              // dominant term
    + 6 * compDelta(champ)                               // how much the comp modifier improves
    + 2 * flexValue(champ)                               // playable in >1 of my empty slots
    - 3 * denialRisk(champ)                              // opponent also wants it
```

Greedy over all `(champion, empty slot)` pairs, with **1-ply lookahead**: simulate the
opponent's best reply by the same function and subtract 0.35 of their gain. No deeper search —
depth here produces a bot that beats humans, which is the wrong outcome.

### 4.2 Ban scoring

```
banScore(champ) = max over opponent's 5 cards of
                    ( effRating(card, champ, card.slot) - effRating(card, bestRemaining, slot) )
```

That is: ban whatever costs the opponent the most, measured as the gap between that champion
and their next-best option. This naturally produces pool-targeted bans rather than
"ban the strongest champion", which is the behaviour that makes bans feel smart.

### 4.3 Noise

Every agent decision picks uniformly from the **top 3** candidates rather than the maximum,
seeded from `hash(fixture_id, actionIndex)` so it stays deterministic and auditable. This is
the entire difference between "competent" and "oppressive".

## 5. Realtime transport

```
Client (Nuxt)                Nitro server                 Supabase
   |                              |                          |
   |-- POST /api/draft/action --->|                          |
   |                              |-- validate in DraftRoom   |
   |                              |-- persist action row ---->|
   |                              |-- broadcast on channel -->|
   |<------- realtime: ACTION_LOCKED / TURN_CHANGED ----------|
   |                              |                          |
   |-- channel presence track --->|                          |  (direct to Supabase)
```

- **Authoritative state** lives in an in-memory `DraftRoom` on the Nitro server, one per active
  fixture, hydrated from Postgres on first access.
- **Every action is persisted** to `draft_actions` before it is broadcast, so a server restart
  mid-draft rehydrates exactly where it left off.
- **Broadcast** goes over a Supabase Realtime channel `draft:{fixture_id}`. Clients subscribe
  directly to Supabase; the Nitro server publishes.
- **Presence** uses Supabase Realtime presence on the same channel, client-tracked. Presence is
  advisory only — it drives the "opponent is here" indicator and the no-show decision, never
  the draft state itself.
- **Timer enforcement** is a `setTimeout` inside the `DraftRoom`, plus a lazy check on every
  inbound action (`if now > deadline, resolve the expiry first`), plus a 10-second sweeper that
  walks all active rooms. Three layers because a missed timer freezes a live match.

### 5.1 Known v1 limitation: single instance

`DraftRoom` being in-memory means the Nitro server **must run as a single instance** in v1.
With at most a handful of private leagues this is fine, and it buys a dramatically simpler
implementation than a distributed lock.

This is written down as a constraint, not an accident. The v2 path, in order of preference:
1. Move room state to Redis with a per-fixture lock (Upstash, keeps Nitro stateless).
2. Move the authoritative loop into Postgres: actions as an RPC with `SELECT ... FOR UPDATE`
   on the fixture row, and `pg_cron` every 5 s for timeouts. Slower but needs no new service.
3. Durable Objects / stateful actors if the deployment target ever becomes Cloudflare.

The deployment doc must state `replicas: 1` explicitly, and a startup assertion should fail
loudly if more than one instance registers.

### 5.2 Reconnection

On reconnect the client calls `GET /api/draft/:fixtureId/state` and receives the full
authoritative state (filtered for what that manager may see), then resubscribes. Lost
broadcasts are therefore never fatal. The client treats realtime as an accelerator over a
pollable source of truth, not as the source of truth.

If realtime is unavailable entirely, the client falls back to polling that same endpoint every
2 seconds. The draft becomes less snappy and remains completely playable.

## 6. Anti-cheat surface

Small, because the stakes are small, but worth getting right:

| Vector | Mitigation |
|---|---|
| Reading the opponent's hidden state from the API | The state endpoint filters per requesting manager; the DTO for the opponent is a different type, enforced at the boundary |
| Submitting actions out of turn | Server-side turn check; RLS on `draft_actions` as a second layer |
| Stopping the clock by disconnecting | Timers are server-side and run regardless of connection |
| Replaying or forging actions | Each action carries `(fixtureId, actionIndex)`; the server rejects any index that is not the current one |
| Altering the sim | The sim runs server-side only; the client receives the event log, never the inputs-plus-engine |
| Inspecting the result before watching | The result is in the payload, so this is possible and accepted — spoiling your own replay is your business |

## 7. Absence handling

Three escalating mechanisms, because people have lives:

**1. Auto-draft (automatic).** Covers a one-off absence. No action needed, no penalty beyond
playing a draft you did not choose.

**2. Reschedule (2 per manager per season).** Requested at least 2 hours before `M`. The
opponent is notified and has until `M` to accept. On acceptance the fixture moves to the next
**rest day** ([01 section 3](01-game-loop.md)); if no rest day remains before the playoffs, the
request is refused by the system rather than by the opponent. A declined request simply leaves
the fixture where it is and auto-draft handles the absence.

**3. League pause (owner only).** Freezes the whole season for 1-7 days, shifting every
remaining fixture. For holidays and exam weeks.

Rest days exist primarily to be the landing zone for mechanism 2.

## 8. Draft screen requirements

Mobile-first, one-handed, portrait. See [09 — Screens](09-screens.md) for layout.

Must show, without scrolling:
- Whose turn it is and the countdown, unmissably.
- The two teams' five slots with card portraits, filling in as picks lock.
- Your own composition modifier with its contributing factors, updating live.
- The ban row for both sides.

Must be one tap away:
- The champion grid, filtered by default to **your lineup's mastered champions**, with a toggle
  for all champions. Mastery is shown as a bar on every tile.
- The opponent's pools, searchable, sorted by mastery.

The default filter is the whole design in one detail: it makes the obvious action the one that
respects your collection, while leaving the off-pool gamble exactly one tap away.

## 9. Open questions

- **Grace period length.** 60 s may be too short for someone who opens the app at `M + 0:30`
  and needs to load. Consider 90 s, or starting the draft as soon as both are present.
- **Should hovering be broadcast?** Fun, but on a 30-second timer it may just be noise.
- **Fearless draft mode.** Across a season, previously picked champions become unavailable.
  Very attractive for a 10-match league because it forces collection breadth — but it needs
  careful interaction with pool size. Strong v1.1 candidate.
- **Agent strength.** "Top 3 uniformly" is a guess. Measure the agent's win rate against humans
  in playtest; target 35-45%.
- **Spectating.** Should the other four managers be able to watch a live draft? Socially great,
  but it leaks pool information across the league.
