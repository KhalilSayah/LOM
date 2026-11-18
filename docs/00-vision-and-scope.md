# 00 — Vision & Scope

## 1. The pitch

You and up to five friends create a private league. Each of you gets a starter squad of five
player cards — one per role — drawn from real professional League of Legends players in a
specific season. Every day you open a pack, and every day your league meets for one match:
a live ban/pick draft against another manager, then a simulated game that plays out on an
animated map. Results feed a season table. At the end of the season there are playoffs, a
champion, and a reset into the next season with your collection intact.

The fantasy is **being the coach/GM**, not the player. You never click a skillshot. You decide
who is on your roster, what they practice, and what you draft.

## 2. Why player-season cards

A card is not "Faker". A card is **Faker 2024** — a snapshot with that season's champion pool,
that season's numbers, that season's team and jersey. This gives the collection:

- **Depth without inventing anything.** ~15 seasons x ~4 major regions x ~50 relevant players
  per region-season = thousands of distinct, legitimately different cards.
- **Real arguments.** "Is Chovy 2023 better than Faker 2016?" is the reason the game is fun to
  talk about in a group chat.
- **A natural rarity axis.** Worlds-winning seasons are rare. A 2019 LCS support is common.
- **Honest stats.** Every number is computed from match data, with the source visible on the
  card back. No designer fudging.

## 3. The core tension

The draft is where the collection pays off. A player card carries a **champion mastery pool**
derived from what they actually played that season. Drafting a card onto a champion they
mastered gives them close to their full rating; drafting them onto something off-pool is a
real penalty. So:

- Bans are aimed at champion *pools*, not just champions. Banning Azir against a Faker 2017
  card is a meaningful read.
- A deep collection is wide, not just high-rated. Five 90-OVR mids with the same narrow pool
  are worse than three mids who collectively cover fifteen champions.
- Mastery tokens from packs let you widen a favourite card over time.

## 4. Session shape

Target: **10 minutes a day**, with optional depth.

| Phase | Duration | Required? |
|---|---|---|
| Claim daily pack, reveal card | ~30 s | Optional (packs accrue, see [02](02-cards-and-collection.md)) |
| Set lineup / review opponent | 1-3 min | Optional, defaults carry over |
| Live ban/pick draft | ~6 min | **Live, at the league's match hour** |
| Watch replay | 2-4 min (skippable) | Optional |
| Standings & rewards | ~30 s | Automatic |

## 5. In scope for v1

- Email/OAuth account, one profile per user.
- Create/join a private league by invite code. 2-6 managers.
- Starter squad grant: 5 cards, one per role, tuned rating band.
- Daily pack: one card-slot pull from a drop table (player card, mastery token, coach card,
  or credits).
- Collection browser with filter/sort, card detail view with real stats and source attribution.
- Lineup editor: choose the starting five, set one of three team strategy presets.
- Scheduled daily fixture per league, generated as a double round-robin.
- Live synchronous draft: 10 bans, 10 picks, standard competitive order, per-action timer,
  auto-pick on timeout, full auto-draft on no-show.
- Deterministic match simulation producing a timestamped event log.
- 2D animated replay of that event log on a Summoner's Rift map, with scoreboard, gold graph,
  speed controls and skip.
- Post-match: box score per player, standings table, XP and credit rewards.
- Season end: top-4 playoff bracket, champion, season reset with collection retained.
- Automated data pipeline producing the card catalogue.

## 6. Explicitly out of scope for v1

Deferred to the management layer — see [10 — Roadmap](10-roadmap.md).

- Transfer market / trading between managers / auction house
- Contracts, wages, budgets, sponsorships, any economy with money
- Training schedules, stamina, morale, form, injuries
- Scouting, academy teams, youth prospects
- In-game substitutions, mid-season role changes
- Champion mastery grinding beyond token spend
- Public/open leagues, matchmaking outside your friend group
- Multi-game series (Bo3/Bo5)
- Cosmetics, skins, card art variants
- Push notifications beyond a single "match starts in 15 minutes" (v1.1)
- Spectating other managers' matches live

## 7. Non-goals (permanent)

- **Not a real-money game.** No purchasable packs, no loot box money. If monetisation ever
  happens it is a flat subscription for league hosting. This keeps the data-licensing and
  gambling-regulation surface clean.
- **Not an esports betting product.** No wagering, no odds, no real-money stakes.
- **Not a prediction of actual upcoming matches.** The sim is a game system tuned for fun and
  legibility, not a predictive model of real esports results.
- **Not an official Riot product.** All uses of Riot assets stay inside the Legal Jibber Jabber
  policy; see [03 section 8](03-data-pipeline.md).

## 8. Success criteria for v1

A v1 is good enough to keep building on when, in a 14-day season with 6 real friends:

1. >= 80% of scheduled drafts have both managers present at the match hour.
2. >= 60% of replays are watched past the 15-minute game mark rather than skipped.
3. The league group chat argues about a draft at least once per week.
4. The highest-OVR squad does **not** win more than ~65% of its matches — the draft has to
   matter more than the collection.
5. Median time from opening the app to being drafted and done is under 12 minutes.

Criterion 4 is the one that decides whether the sim is tuned correctly; see
[04 section 9 — Balance targets](04-simulation-engine.md).

## 9. Glossary

| Term | Meaning |
|---|---|
| **Manager** | A human user. |
| **League** | A private group of 2-6 managers playing a season together. |
| **Squad** | A manager's full collection of player cards. |
| **Lineup** | The five cards chosen to start today's match, one per role. |
| **Card** | A player-season (e.g. `faker-2024`) or a non-player item card. |
| **OVR** | Overall rating 40-99, derived from season data. |
| **Mastery** | 0-100 per (card, champion), derived from that season's games played. |
| **Match day** | One calendar day in a league season; each manager plays exactly one match. |
| **Fixture** | A scheduled match between two managers on a match day. |
| **Sim** | The deterministic engine that turns two drafted teams + a seed into an event log. |
| **Replay** | The client-side animated playback of a sim event log. |
