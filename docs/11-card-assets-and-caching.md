# 11 · Card assets and caching

How a card is generated, what gets stored, in what format, and what makes a preview open
instantly the second time. This is the read path for every screen in
[09-screens.md](09-screens.md): the collection grid, the card sheet, the draft board and the
pack opening.

The short version: **store the card as data, store the art as pre-sized WebP, render the card
in the DOM.** Do not store pictures of cards.

---

## 1. A card is two things

| | What it is | Where it lives | Changes when |
|---|---|---|---|
| **Card data** | ~40 numbers and strings: OVR, six sub-stats, champion pool, season line, provenance | Postgres row, mirrored into a versioned catalogue bundle | the pipeline re-mints a catalogue |
| **Card art** | one champion splash, one optional player portrait, up to four champion squares | Object storage, content-addressed | the source image changes (rarely) or Data Dragon bumps a patch |

They have completely different lifetimes, so they get completely different caching. Card data
is small and changes per catalogue version. Art is large and effectively never changes.

The rendered card is neither — it is a function of the two, computed in the browser by
`@lom/card-engine`. That is the decision everything else follows from, so section 6 argues it.

---

## 2. Formats

### 2.1 Art: WebP, one format, no negotiation

| Derivative | Size | Source | Format | Typical weight |
|---|---|---|---|---|
| `card` | 420 × 588 | champion splash, cropped to the card trim at 2× | WebP q72 | 38–55 KB |
| `thumb` | 168 × 235 | same crop, grid size at 2× | WebP q68 | 7–11 KB |
| `portrait` | 420 × 588 | player cutout, **alpha preserved** | WebP q76, alpha | 28–48 KB |
| `square` | 64 × 64 | champion square | WebP q75 | 2–3 KB |

**Why WebP and not AVIF.** AVIF is roughly 25–30% smaller at the same quality, and it is
tempting. It also costs a second derivative set, a capability probe at boot and a `<picture>`
element in a template that currently resolves one URL per image. For a private league the
whole art working set is a few megabytes; 30% of a few megabytes is not worth the branch.
WebP has been safe on every browser LOM targets since 2020 (iOS 14), the PWA requires a modern
browser anyway, and the resolver in `src/assets.js` can be pointed at an AVIF set later without
touching the template. Revisit when the catalogue passes ~2,000 cards or when a cellular cold
open is measured as the bottleneck — not before.

**Why not one size.** The collection grid shows up to 24 cards at ~84 pt. Serving the 420 px
derivative there costs 24 × 45 KB ≈ 1.1 MB to paint thumbnails that need 190 KB. One extra
derivative at mint time removes that permanently.

**Why 2×.** Phones are the target. A 1× asset on a 3× screen is visibly soft on the one screen
the player stares at. 2× is the honest compromise; 3× doubles the bytes for a difference
almost nobody sees on a photographic source.

**Alpha matters for portraits only.** The composite in `src/template.js` puts the player cutout
over a blurred splash; over a flat colour a cutout looks like clip art. So portraits keep their
alpha channel, and that rules out JPEG for that one derivative.

### 2.2 Card data: JSON, versioned, immutable

The canonical row is Postgres ([07-data-model.md](07-data-model.md)). The read path is a
**catalogue bundle**: one JSON file per catalogue version holding the static facts for every
card in the league's pool.

```
catalogue/2026.11.1.json      immutable, gzipped
catalogue/latest.json         { "version": "2026.11.1" }, max-age=60
```

A card entry is what `normaliseCard()` already expects, so the bundle is the engine's input
with no translation layer:

```json
{
  "cardKey": "faker-2016", "playerName": "Faker", "season": 2016,
  "team": "SKT T1", "region": "LCK", "role": "MID", "ovr": 97,
  "accolades": ["WORLDS_WINNER", "FINALS_MVP"],
  "subStats": { "laning": 94, "teamfight": 96, "mechanics": 98, "macro": 93, "vision": 79, "consistency": 97 },
  "championPool": [{ "champion": "Ryze", "key": "Ryze", "games": 34, "mastery": 97, "winrate": 0.71 }],
  "seasonSummary": { "Games": 88, "KDA": "5.8", "GD@15": "+341", "DPM": 596 },
  "artFocus": "50% 50%",
  "provenance": "Derived from 88 games (LCK, Worlds) — Oracle's Elixir. Catalogue 2026.11.1."
}
```

Roughly 260 bytes gzipped per card. A league pool of ~300 cards is a **~80 KB** bundle,
fetched once per catalogue version and then never again.

What is deliberately **not** in the bundle: anything per-player-account (ownership, card level,
XP, duplicates). That is mutable, it is per user, and mixing it in would make the one file that
could be immutable un-cacheable. It comes from the API and is joined client-side on `cardKey`.

---

## 3. Storage layout

Supabase Storage, public bucket, content-addressed paths:

```
art/champion/splash/{championKey}/{hash8}-card.webp
art/champion/splash/{championKey}/{hash8}-thumb.webp
art/champion/square/{championKey}/{hash8}.webp
art/portrait/{cardKey}/{hash8}-card.webp
art/portrait/{cardKey}/{hash8}-thumb.webp
catalogue/{version}.json
```

`hash8` is the first 8 hex of the SHA-256 of the **source** image plus the derivative recipe
(size, quality, crop). Two consequences, both of which are the point:

1. Every URL can be served `Cache-Control: public, max-age=31536000, immutable`. A client that
   has the file never asks again — no revalidation, no 304, no round trip.
2. Re-cropping or re-encoding produces a new path. Nothing is ever overwritten, so there is no
   cache to purge and no window where half the world sees the old crop.

The hash-to-URL mapping lives in the catalogue bundle (one `art` object per card), so resolving
an image costs no extra request.

---

## 4. Caching, layer by layer

| Layer | What it holds | Policy |
|---|---|---|
| HTTP, art | every derivative | `max-age=31536000, immutable` |
| HTTP, bundle | `catalogue/{version}.json` | `max-age=31536000, immutable` |
| HTTP, pointer | `catalogue/latest.json` | `max-age=60` |
| Service worker | art + bundles | cache-first; never network-first, the paths are immutable |
| IndexedDB | the parsed bundle, keyed by version | read on boot before any network call |
| Memory | decoded `Image` objects | the browser's own decoded-image cache, warmed by `preloadCards()` |

**Boot order.** Read the bundle from IndexedDB and render from it immediately; fetch
`latest.json` in the background; if the version moved, fetch the new bundle and swap it in. The
app is interactive before the network answers, every time after the first.

**Eviction.** Keep the two most recent bundles and drop the rest on boot. For art, let the
service worker cache grow and trim it least-recently-used past ~40 MB; the whole league pool is
smaller than that, so in practice nothing is ever evicted.

---

## 5. Preview paths and their budgets

| Screen | Needs | Cold | Warm |
|---|---|---|---|
| Collection grid, 24 cards | 24 `thumb` | ~220 KB | 0 |
| Card sheet | 1 `card` + 4 `square` | ~55 KB | 0 |
| Pack opening, 5 cards | 5 `card` + 20 `square` | ~280 KB | 0 |
| Draft board, 10 cards | 10 `thumb` | ~95 KB | 0 |

**Preloading is part of the design, not an optimisation.** `preloadCards()` in
`src/assets.js` fetches and *decodes* a card's images and resolves when they are ready. The
pack opening calls it while the pack is still sealed, so by the time the card turns over the
image is in the decoded cache and the paint is free. A reveal that shows a blank card and fills
it a beat later destroys the one moment in the game that is pure theatre. The call is capped at
6 s and never rejects: a slow CDN delays the art, it does not hold the animation.

The same hook belongs on the grid (preload the next page while the player scrolls) and on the
draft (preload all ten rosters when the lobby fills, during the countdown nobody is watching).

---

## 6. Why the card is not a stored image

The obvious alternative is to render each card to a PNG at mint time and serve that. It is
wrong here, and it is worth writing down why, because it will come up again:

- **A design change re-renders the catalogue.** The poster layout replaced the framed-window
  layout after this engine already existed. With DOM rendering that was a CSS commit; with
  stored images it is a batch job over every card in every size, plus a cache generation bump.
- **It is bigger, not smaller.** A card PNG with text baked in does not compress like a photo:
  ~120 KB against ~45 KB for the art alone, and the squares are already cached separately.
- **It kills the card.** No tilt, no foil tracking the pointer, no flip to the provenance face,
  no text to select, nothing for a screen reader. The card stops being an object and becomes a
  picture of one.
- **Rarity is a theme, not a texture.** Five bands come from `src/rarity.js` as CSS variables
  over one code path. Pre-rendering multiplies the asset count by five for no gain.

**The one exception is share images.** A card posted to a chat has to be a real image file.
Render those on demand server-side (`docs/09-screens.md` section 12), cache by
`{cardKey}-{catalogueVersion}`, and treat them as a separate output — not as the thing the app
itself displays.

---

## 7. What the pipeline does at mint time

Per [03-data-pipeline.md](03-data-pipeline.md), when a catalogue version is cut:

1. Compute card data from match rows; write the Postgres rows.
2. For each distinct champion in any card's pool: fetch the Data Dragon splash and square if the
   patch moved, produce `card`, `thumb` and `square` derivatives, hash, upload if the path is
   new.
3. For each card with a cleared portrait: produce `card` and `thumb` with alpha, hash, upload.
4. Write `catalogue/{version}.json` with each card's data and its resolved art paths.
5. Flip `catalogue/latest.json`.

Step 2 and 3 skip everything already on disk by hash, so a catalogue cut that changes only
numbers uploads nothing at all.

---

## 8. Open questions

- **Skin variants.** `splash/{key}_{skinNum}.jpg` exists and a skin in the player's team colours
  would be a cheap, good-looking variant. It multiplies the derivative count; worth it only if
  variants become a collectible axis.
- **Per-champion crops.** `artFocus` is eyeballed per card today. It should be computed once per
  champion at ingest (face detection or a hand-checked table) rather than carried per card.
- **Portrait licensing.** Everything above assumes portraits exist. They are fair-use tagged and
  not cleared for a public build; see the warning in
  [packages/card-engine/README.md](../packages/card-engine/README.md). The champion-art path
  needs no clearance and is the fallback, with no code change.
- **Bundle granularity.** One bundle per league pool is right at 2–6 players. If LOM ever has a
  global catalogue, this becomes a paged query with the same caching rules.
