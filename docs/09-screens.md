# 09 — Screens

Mobile-first, portrait, one-handed. Design target: a 390x844 viewport. Desktop is a centred
column with a wider draft and replay view; it is never the primary design case.

## 1. Navigation

A four-tab bottom bar, always reachable:

```
  [ Today ]   [ Squad ]   [ League ]   [ Packs ]
```

Plus a context-driven **primary action button** that floats above the tab bar and always shows
the single most important next thing: *Claim pack* -> *Set lineup* -> *Enter lobby* ->
*Watch replay* -> *See standings*. If a player only ever taps that button, the whole daily loop
works. That is the test for whether the information architecture is right.

## 2. Screen inventory

| # | Screen | Route | Purpose |
|---|---|---|---|
| 1 | Sign in | `/` | Discord / Google / magic link |
| 2 | Create profile | `/onboarding` | Handle, display name |
| 3 | League hub (no league) | `/leagues` | Create or join by code |
| 4 | League lobby (forming) | `/l/:id/lobby` | Members, invite code, settings, Start season |
| 5 | **Today** | `/l/:id` | The home screen. Today's fixture, countdown, pack, primary action |
| 6 | Pack opening | `/l/:id/packs/:entitlementId` | The reveal |
| 7 | **Squad** (collection) | `/l/:id/squad` | Grid, filters, search |
| 8 | Card detail | `/l/:id/card/:cardId` | Stats, pool, provenance, compare |
| 9 | Lineup editor | `/l/:id/fixture/:fid/lineup` | Five slots, strategy, coach, chemistry |
| 10 | Scouting | `/l/:id/fixture/:fid/scout` | Opponent's recent form and pools |
| 11 | Match lobby | `/l/:id/fixture/:fid/lobby` | Countdown, presence, both lineups |
| 12 | **Draft** | `/l/:id/fixture/:fid/draft` | The live ban/pick |
| 13 | **Replay** | `/l/:id/fixture/:fid/replay` | Animated map |
| 14 | Match result | `/l/:id/fixture/:fid/result` | Box score, grades, rewards |
| 15 | **League** | `/l/:id/standings` | Table, schedule, history, honours |
| 16 | Settings | `/settings` | Profile, notifications, league settings (owner) |

## 3. Today

The screen that must work.

```
┌──────────────────────────────────┐
│  Autumn Split · Day 7 of 14      │
├──────────────────────────────────┤
│  ▸ DAILY PACK READY              │   collapses once claimed
│    tap to open                   │
├──────────────────────────────────┤
│                                  │
│      YOU  vs  SAM'S TEAM         │
│      3-2        4-1              │
│                                  │
│      ⏱  draft in 2h 14m          │   live countdown, server-synced
│         20:30 tonight            │
│                                  │
│   Lineup: ✓ set   Strategy: ⚡    │
│                                  │
├──────────────────────────────────┤
│  STANDINGS          (top 3)      │
│  1 Sam   12pts   2 You  9pts ... │
├──────────────────────────────────┤
│  [    REVIEW LINEUP    ]         │   ← primary action, changes by state
└──────────────────────────────────┘
```

State-dependent primary action: `Claim pack` -> `Set lineup` -> `Enter lobby` (from `M-15`) ->
`Watch replay` -> `See result`.

## 4. Squad (collection)

- Virtualised grid, 3 across on mobile, grouped by role with sticky role headers.
- Card tile: portrait (or generated avatar), OVR corner badge, rarity frame, role pip, level
  pip, and a **pool-depth bar** — how many champions at mastery >= 70. That last element is
  what teaches players that breadth is the real currency.
- Sticky filter bar: role chips, rarity chips, a sort control, and a search field that matches
  player name *or* champion name ("who can play Azir?" is a question people will ask daily).
- Long-press a tile to add it to **Compare** (max 2), which opens a side-by-side radar.

## 5. Card detail

Sections, top to bottom:

1. Hero: art, name, **season year prominently**, team, region, role, rarity frame.
2. OVR, and the six sub-stats as a labelled radar with numeric values.
3. **Champion pool** — the biggest section. Each row: icon, name, mastery bar, games played,
   winrate. Rows above mastery 70 are visually separated from the long tail.
4. Level/XP bar, with the next level's reward named.
5. **Real season**: games, K/D/A, GD@15, DPM, vision — the card back.
6. **Provenance line**: "Derived from 68 games (LCK Spring/Summer, Worlds) — Oracle's Elixir,
   Leaguepedia. Catalogue 2026.11.1." Small, always present, non-negotiable. It is what makes
   the numbers trustworthy instead of arbitrary.

## 6. Lineup editor

```
┌──────────────────────────────────┐
│  ROSTER                    4 / 5 │
├──────────────────────────────────┤
│  RATING 84.2  CHEM +3.5  POOL 41 │
├──────────────────────────────────┤
│  TOP   JNG   MID   BOT   SUP     │
│ ┌───┐ ┌───┐ ┌───┐ ┌───┐ ┌ - ┐    │
│ │art│ │art│ │art│ │art│ │ + │    │  <- five slots, all visible
│ └───┘ └───┘ └───┘ └───┘ └ - ┘    │
│   86    83    91    88    ··     │
├──────────────────────────────────┤
│  ┌────────┐  SUP                 │
│  │        │  Keria 2024          │  <- the slot in focus, full size
│  │  card  │  T1 · 7 deep · LV 3  │
│  │        │  +2.5 chemistry      │
│  └────────┘  [ Take out ]        │
├──────────────────────────────────┤
│  YOUR SUP CARDS (12)   [search]  │
│  ┌──┐┌──┐┌──┐┌──┐┌──┐┌──┐        │  <- tap one to place it
│  └──┘└──┘└──┘└──┘└──┘└──┘        │
├──────────────────────────────────┤
│  Combined pool covers 41 champs  │
│  Weakest coverage: JNG (6)       │
└──────────────────────────────────┘
```

A board, not a list. This screen used to be five text rows — `TOP [ Zeus 2023 ] 86 ▸` — and
rows are wrong for a collecting game: the art, the frame and the rarity are most of why a
card is worth owning, and none of them survive being flattened into a line of text. A lineup
is also the thing a manager shows people, which a list is not.

Tapping a slot **selects** it rather than opening a picker over the top. A modal hides the
board you are trying to build, and comparing two options through one costs a round trip each
way. Selecting filters the cards underneath to that role, sorted by OVR, and shows whatever
is in the slot at full size above them — so the card you are about to replace and the cards
you might replace it with are on screen together.

A card already in another slot is dimmed and labelled with the slot it is in, rather than
hidden: moving someone from BOT to MID is a thing people do deliberately, and it should not
require emptying the other slot first.

The **pool coverage** line is a small feature with a large teaching effect: it tells you,
before the draft, where you are vulnerable to bans.

Locking: the screen shows a countdown to lineup lock at `M - 30s` and goes read-only after.

## 7. Draft

The hardest screen to fit on a phone. Layout, top to bottom:

```
┌──────────────────────────────────┐
│ YOU 🔵        ⏱ 0:23      🔴 SAM │   turn indicator + countdown dominate
│ ban ▢▢▢▢▢            ▢▢▢▢▢ ban  │
├──────────────────────────────────┤
│ TOP  Zeus    [Jax]  │  [K'Sante]│   five rows, both sides, filling in
│ JNG  Oner    [ -- ] │  [Vi]     │
│ MID  Faker   [ -- ] │  [ -- ]   │
│ BOT  Guma    [ -- ] │  [ -- ]   │
│ SUP  Keria   [ -- ] │  [ -- ]   │
├──────────────────────────────────┤
│ COMP  +0.04  ▴frontline ▾AD-only │   your side only, live
├──────────────────────────────────┤
│ [ My pools ] [ All ] [ Theirs ]  │
│ ┌────┬────┬────┬────┬────┐       │
│ │Azir│Ori │Ahri│Syn │... │       │   mastery bar under each icon
│ │ 94 │ 88 │ 79 │ 61 │    │       │
│ └────┴────┴────┴────┴────┘       │
├──────────────────────────────────┤
│  [      LOCK IN  Azir → MID   ]  │
└──────────────────────────────────┘
```

Rules for this screen:

- The countdown is the largest element on screen and changes colour under 10 seconds.
- Default champion-grid tab is **My pools**, sorted by the mastery of whichever of your unfilled
  slots is best on that champion. One tap to **All**, one tap to **Theirs** (for ban reasoning).
- Selecting a champion then a slot, or a slot then a champion — both orders work. The lock-in
  button names exactly what will happen.
- An `AUTO_ACTION` badge appears on any action the agent took, so nobody is confused about why
  their jungler is on Teemo.
- Opponent hover shows as a pulsing outline on their next empty slot.
- `prefers-reduced-motion` disables the pulse and the countdown animation, not the information.

## 8. Replay

```
┌──────────────────────────────────┐
│  🔵 7 - 4 🔴        18:42        │   scoreboard + game clock
│  ▁▂▃▅▆▅▃  +2.1k                  │   gold-diff sparkline
├──────────────────────────────────┤
│                                  │
│        [ Summoner's Rift ]       │   Canvas 2D, 10 dots, structures
│                                  │
├──────────────────────────────────┤
│  18:40  Faker catches Chovy in   │   event ticker, auto-scrolling
│         the river                │
│  18:12  Blue takes Infernal Drake│
├──────────────────────────────────┤
│  ◀◀  ▶  ▶▶   [1× 2× 4× 60×]      │
│  ━━━━━━━━●───────────────────    │   scrubber
│  [ Skip to result ]              │
└──────────────────────────────────┘
```

- Default speed 60x. The whole game in about half a minute, with the ticker readable.
- Tapping a champion dot pins that player's live stat line.
- Objective takes and teamfights trigger a brief banner and a slow-down to 8x for 3 seconds,
  then resume — the single cheapest trick for making a replay feel dramatic.
- **Skip to result** is always visible and never buried. Forcing someone to watch is how you
  teach them to skip forever.
- Reduced-motion default: ticker-only view with the map as a static image.

## 9. Match result

- Winner banner, final score, game length.
- Box score table, your five then theirs, sortable: champion, K/D/A, CS, gold, damage share,
  vision, **grade**.
- Grades are the emotional payload: an S+ on a 74 OVR card is the thing people screenshot.
- Rewards strip: credits earned, XP per card, any level-ups.
- "What decided it" — three auto-generated lines from the highest-impact events (first baron,
  the biggest teamfight margin, the lane that broke). Generated from the event log, not an LLM.
- Buttons: `Watch again`, `Standings`, `Share` (renders an image card).

## 10. League

Three tabs: **Table**, **Schedule**, **History**.

- Table: position, team, W-L, points, game-time differential. Tapping a row expands the
  tiebreak detail, because tiebreaks cause arguments.
- Schedule: all 14 days, past results inline, today highlighted, future fixtures with
  opponents. Reschedule requests appear here.
- History: every match ever played in the league, rewatchable. Plus the honours board of past
  champions.

## 11. Pack opening

Deliberately short: a 2-second reveal with a rarity-coloured burst, the card flying in, and a
**Keep opening** button if more entitlements are banked. Pity progress ("Legendary in at most
12") sits under the button permanently.

A duplicate shows the XP gain and the token granted in the same beat; it must never feel like
nothing happened.

## 12. Cross-cutting requirements

| Concern | Requirement |
|---|---|
| Offline | The PWA shell, the collection and past replays are available offline from cache. Drafting obviously is not; show a clear offline state |
| Countdowns | Always server-synced ([08 section 9.3](08-api-and-realtime.md)); never drift when backgrounded |
| Loading | Skeletons, never spinners, on collection and league screens |
| Errors | Inline and specific. "Not your turn" must say so, not "Something went wrong" |
| Reduced motion | Honoured on replay, pack opening and draft pulses |
| Colour | Never encode information by colour alone — blue/red sides also carry icons and position |
| Text size | Respect the OS text scale; the draft screen must survive 130% |
| Dark mode | Default and primary. Light mode is a second-class citizen but must not be broken |
| Share | Result and card screens render a 1200x630 image server-side for group chats |

## 13. Open questions

- **Four tabs or three?** Packs could live inside Today, freeing a tab for a future Market.
- **Desktop draft** could show both champion grids side by side. Worth doing early, since
  playtesters will inevitably draft on a laptop.
- **Does the replay need a minimap-sized mode** so it can play while the ticker scrolls above
  it on small phones?
- **Share images** are a late addition but might be the strongest growth mechanic in a
  friend-group game. Possibly promote into the v1 build.
