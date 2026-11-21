# 12 — Sponsors

## 1. Why this exists

Before match rewards were built, Credits came from exactly one place: a duplicate pull. The
shop was funded by the thing the shop sells. [01 section 5](01-game-loop.md) always had the
match payouts written down, and they are now live — but a single faucet with no decision
attached to it is still just a number going up.

A sponsor is the second faucet, and it has a decision in it.

[00 section 6](00-vision-and-scope.md) put sponsorships in the management layer, out of
scope for v1. That was right while nothing paid at all. It is wrong now, for one reason: the
collection has no mechanical reason to be *wide*. Chemistry rewards a team core, the draft
rewards champion breadth, and nothing at all rewards owning a Korean support you would not
otherwise field. A sponsor demand does, and it does it without touching the sim, the draft,
or a single balance number.

## 2. The shape of a contract

| Part | What it does |
|---|---|
| **Signing bonus** | Paid once, the first time this brand is signed into a slot |
| **Appearance fee** | Paid for every match played with it signed, whatever happened |
| **Bonus** | Paid on top, only when the demand was met |
| **Demand** | A condition on the five you fielded, or on the match |
| **Term** | Three matches before it can be released for nothing |

The split is the whole design. If a sponsor paid only on its demand it would be a tax on
bad evenings; if it paid the same regardless it would be a tap. The appearance fee means
signing is never a trap, and the bonus means the demand is worth building towards.

Brands are **fictional and permanently so**. A real sponsor's name on a card is a trademark
problem the card catalogue does not have — its players, teams and seasons are factual
record. Same argument [02 section 2.6](02-cards-and-collection.md) makes for coaches being
archetypes rather than real people.

## 3. Demands

Every kind is decidable from the lineup snapshot the duel already stores and the result the
engine already produced. Nothing needs a lookup, which is what keeps a payout explainable
from the match that was just watched.

| Kind | Reads | Example |
|---|---|---|
| `REGION` | the five | Field 3 starters from the LCK |
| `CORE` | the five | Field 3 players from the same real team and season |
| `MAX_OVR` | the five | Average squad rating of 82 or under |
| `MAX_RARITY` | the five | Nobody above Epic in the five |
| `SEASON_RANGE` | the five | Field 2 starters from 2011–2017 |
| `KILLS` | the result | Take 25 kills as a team |
| `WIN` | the result | Win the match |
| `FAST_WIN` | the result | Win inside 30 minutes |
| `NONE` | nothing | The appearance fee is all there is |

They live in `shared/sponsors.ts`, as does the English each one renders to. The catalogue
stores the demand as data and no label beside it: a hand-written label is a second source of
truth that drifts the first time a threshold is tuned in SQL.

Two demands are deliberately *not* here. Nothing reads a manager's standing in the league,
because a sponsor that pays the leader widens the gap a 14-day season cannot absorb. And
nothing reads champion picks, because that is the draft's own fight and a brand leaning on
it would be balance pressure wearing a costume.

## 4. Slots and the term

Two slots (`SPONSOR_SLOTS`). Owning a contract pays nothing; signing it into a slot does.

A signed contract runs **three matches** before it can be released for free. Without a term,
the constraint costs nothing: you would sign whichever brand happened to match the five you
already meant to field, collect the bonus, and swap tomorrow. Leaving early is allowed as a
**buy-out** priced at the signing bonus — a commitment with no way out is a trap, and a trap
is not a decision either. The term counts matches played under the contract, met or not:
serving it is about honouring the deal, not about collecting on it.

Re-signing a brand you once held pays no second signing bonus. `signed_at` is the record of
that, and without it a slot would be a button that prints money.

## 5. Where they come from

A **sponsor meeting**: 600 Credits, one contract, from `SPONSOR_PACK` in
`shared/sponsors.ts`.

| Tier | Weight |
|---|---|
| Common | 46% |
| Rare | 30% |
| Epic | 17% |
| Legendary | 6% |
| Icon | 1% |

The roll prefers a brand the manager does not hold, walking the ladder down and then up when
a tier is exhausted — the same shape as the card roll in `server/utils/roll.ts`, and for the
same reason: a pack that hands back something you cannot use feels broken even when the
duplicate pays. A brand already held pays `SPONSOR_DUPLICATE_CREDITS` for its tier instead.

Unlike card packs, the price and weights are in code rather than in a table. The sponsor
catalogue is a dozen hand-written contracts, not a generated set; its tiering is part of the
design rather than a balance dial, and a second pack table for one row would be ceremony.

## 6. What a match pays

[01 section 5](01-game-loop.md) is the table. `shared/rewards.ts` is the arithmetic;
`server/utils/rewards.ts` is the part that touches the database.

- One row in `match_rewards` per manager per duel. The unique index on
  `(duel_id, profile_id)` is the idempotency lock: `finish()` in `server/utils/duelRun.ts`
  can be reached twice in the same instant by two clients nudging the same expired deadline,
  and the second has to be a no-op rather than a second payday.
- The row is claimed **before** anything is granted. There is no transaction to be had over
  PostgREST, so the order is chosen for survivable failures: claim, Credits, XP, receipt.
- The receipt is stored and the result screen renders it rather than recomputing it. A screen
  that works the numbers out for itself can disagree with the ledger, and the ledger is what
  the Credits pill is counting.
- A Ghost pays at 50%, Credits and XP both, per [01 section 6](01-game-loop.md). Sponsors are
  halved with everything else, so a Ghost is not the way around the rate.
- **The Ghost allowance** is not in the spec: past three paid Ghost matches in a pack-day, a
  Ghost pays card XP and no Credits. The spec's Ghost is the bye in an odd league — one a day,
  unavoidable. `/api/duel/queue/bot` hands out an agent opponent on demand, which makes an
  unbounded Ghost a faucet with a tap on it.
- The first win of a season is a league fixture question, decided by looking at the other
  fixtures in that league once this one is `FINAL`. A friendly cannot be the first win of
  anything, and neither can a Ghost.

## 7. Not built

**Season payouts are built now**, and they used to be the first entry here. The 1500 / 900 /
500 / 250 row of [01 section 5](01-game-loop.md) needed a season that finishes, and a league
has one: a top-four bracket drawn off the final table, a grand final that sets the league
FINISHED with a champion on it, and one `season_rewards` row per manager per season to pay
against. They are not sponsor money — a placing is paid by the league, not by a brand — but
they were listed here because this document was written the week the second faucet landed and
the third one was the obvious hole left in [01 section 5](01-game-loop.md). It is filled.

- **A weekly retainer.** Tempting, and it needs either a scheduler the app does not have or a
  lazy claim surface with its own week window. Per-match money plus the signing bonus covers
  the same ground without inventing either.
- **Sponsors in card packs.** Card packs produce PlayerCards only and `roll.ts` is written on
  that assumption ([02 section 5](02-cards-and-collection.md) is explicit). A dedicated
  meeting keeps that untouched.

## 8. Open questions

- **Is two slots too few?** Two forces a choice between demands, which is the point. If
  playtest shows managers signing the two softest contracts and ignoring the rest, the fix is
  more interesting demands, not more slots.
- **Does the term read as commitment or as friction?** Three matches is a guess. The buy-out
  is the escape valve; if it is used constantly the term is too long.
- **Do region demands push collections towards one region** in a way that makes the draft
  narrower rather than wider? The chemistry bonus for an all-one-region five already pulls
  that way, and two pulls in the same direction may be one too many.
- **Should a sponsor ever pay a card?** XP instead of Credits, as a training-adjacent reward.
  It would make sponsors interact with progression rather than only with the wallet.
