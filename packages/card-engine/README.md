# @lom/card-engine

Renders a LOM player card from card data. One code path for every rarity, every role and
every player-season in the catalogue.

```bash
node fetch-assets.mjs            # champion art from Data Dragon -> assets/ddragon/  (~1.3 MB)
node fetch-portraits.mjs         # player headshots from Leaguepedia -> assets/portraits/  (see below)
node build-demo.mjs              # -> dist/demo.html      card sheet, art inlined as data URIs
node build-demo.mjs --cdn        # -> dist/demo.cdn.html  ~400 KB, art from the live CDN
node build-demo.mjs --pack       # -> dist/pack.html      pack opening, art inlined
node build-demo.mjs --pack --cdn # -> dist/pack.cdn.html
```

## Why it is plain JavaScript

Sources are ES modules with JSDoc types rather than `.ts`, so the demo runs with no build
step, no `node_modules` and no bundler. Every file ports to TypeScript unchanged when this
moves into `apps/web`. The type annotations are already there; only the file extension and
the `interface` declarations change.

## Files

| File | Role |
|---|---|
| `src/rng.js` | FNV-1a + mulberry32. Same card key, same artwork, forever. Same idiom as `@lom/sim`. |
| `src/assets.js` | Swappable asset resolver. Data Dragon by default; Storage keys or data URIs elsewhere. |
| `src/rarity.js` | The five rarity themes and `rarityForOvr()`. The only place a band's look is defined. |
| `src/artwork.js` | Procedural SVG portrait, seeded from the card key. |
| `src/template.js` | Card markup, front and back. |
| `src/card.css` | Poster face, foil, glare, parallax, back face, compact variant, reduced-motion. |
| `src/tilt.js` | Pointer/touch/gyro controller. Writes CSS custom properties, nothing else. |
| `src/card.js` | `createCard()`, `mountCards()`, `normaliseCard()`. |
| `src/pack.js` | Pack opening: the phase machine and the scene it drives. |
| `src/pack.css` | Pack, rays, burst, banner. Every rule keys off `data-phase`. |
| `src/index.js` | The public barrel. Re-exports only. |
| `samples/cards.js` | Five sample cards, one per rarity. **Placeholder stats, not real data.** |
| `demo/shell.html` | The card-sheet demo page. |
| `demo/pack-shell.html` | The pack-opening demo page. |
| `fetch-assets.mjs` | Pulls champion splash + square art from Data Dragon. Skips what is on disk. |
| `build-demo.mjs` | Inlines everything into `dist/demo.html`. |

## Usage

```js
import { createCard } from '@lom/card-engine';

const { stage, el, controller } = createCard({
  cardKey: 'faker-2016',
  playerName: 'Faker',
  season: 2016,
  team: 'SKT T1',
  region: 'LCK',
  role: 'MID',
  ovr: 97,
  accolades: ['WORLDS_WINNER'],          // 92+ OVR and an accolade => ICON
  subStats: { laning: 94, teamfight: 96, mechanics: 98, macro: 93, vision: 79, consistency: 97 },
  championPool: [{ champion: 'Ryze', games: 34, mastery: 97, winrate: 0.71 }],
  seasonSummary: { Games: 88, KDA: '5.8', 'GD@15': '+341', DPM: 596 },
  provenance: 'Derived from 88 games (LCK, Worlds) — Oracle\'s Elixir. Catalogue 2026.11.1.',
});

document.body.appendChild(stage);
controller.flip();
```

`rarity` is optional — leave it out and `rarityForOvr(ovr, accolades)` decides, so the card
and the collection can never disagree about what band a player is in.

Pass `{ interactive: false }` for a static card (share images, print sheets, server-side
render), and `{ compact: true }` for the collection grid — see "The front face" below.

Opening a pack is one call:

```js
import { mountPack } from '@lom/card-engine';

mountPack(document.getElementById('scene'), card, {
  label: 'Icon pack',
  onReveal: (c) => console.log('revealed', c.cardKey),
  onKeep: (c) => addToCollection(c),
});
```

## The front face

The front is a **poster**: the art fills the card and the data sits on it in one block along
the foot. It was chosen in design review over four alternatives (a framed plate, an ornate
collector medallion, a mono scouting dossier, and a minimal radar face) for three reasons.

- **The art reads before the text.** That is what makes a card feel like a card rather than a
  stat line with a picture attached.
- **The name and the season share a baseline.** Faker 2016 and Faker 2026 are different cards
  with different pools and different numbers ([docs/02](../../docs/02-cards-and-collection.md)),
  so the year is set large in the rarity accent beside the name. It is half the identity, not
  a tag in the corner.
- **It survives the grid.** At 132 px the OVR, the name and the year still read, which means
  the collection screen can use the same template instead of a second one.

Three things make it work and are easy to break:

| | Why it is there |
|---|---|
| The scrim | Text on art needs it. It is opaque at the foot and gone by the midline; lighten it and the numbers go, raise it and the card looks like a dimmed photo. |
| The foil mask | The holo is at full strength over the art and cut to a fifth over the data block. Flooding the whole face washes out the name, the year and the numbers — the three things that must read. |
| The portrait pin | Cutouts vary in aspect. The portrait stands on the panel line at a fixed height rather than being fitted to the card box, so the face lands in the same place on every card. |

`{ compact: true }` adds `.lom-card--compact`, which drops the meters, the pool tiles and the
footer and enlarges the name, year and OVR. Same markup, same code path — it is the collection
grid face, and it is why the poster layout was worth the change.

## How the 3D works

No WebGL and no library. A `.lom-stage` wrapper sets `perspective`, the card takes
`rotateX`/`rotateY`, and inner layers sit at different `translateZ` depths so they shift
against each other as it turns:

| Layer | Depth |
|---|---|
| Specular glare | 42px |
| OVR badge, player name | 22px |
| Art window | 12px |
| Champion pool, stat bars | 7–10px |
| Foil | 2px |
| Plate | 0 |
| Rarity bloom | −80px |

`tilt.js` writes `--mxn`, `--myn`, `--txn`, `--tyn`, `--active`, `--rx`, `--ry` and
`--scale`, throttled to one `requestAnimationFrame`. Everything visual reads those variables
from `card.css`, so the look can be retuned without touching the interaction code.

Touch drags to tilt and taps to flip. Gyroscope is supported through `enableGyro()` where the
host grants motion access, and degrades silently where it does not — most embedded webviews
and artifact frames refuse it without prompting.

## Rarity treatments

| Band | OVR | Foil | Notes |
|---|---|---|---|
| Common | 40–67 | none | Matte stock, steel frame |
| Rare | 68–76 | `sheen` | One specular band tracking the pointer |
| Epic | 77–84 | `prism` | Diagonal spectral bands, amethyst frame |
| Legendary | 85–91 | `rainbow` | Full spectrum + dodge blend, hextech gold |
| Icon | 92–99 **and** an accolade | `prismatic` | Rainbow + animated hue drift + pointer-masked glitter |

The foil layer is masked vertically: full strength over the art window, ~40% over the header
and the stat panel. Flooding the whole face is what makes a holo card unreadable.

## Pack opening

`createPack(card, opts)` builds a scene around one card. The sequence is a state machine, not
one animation, because the interesting part is the pause — the pack charges and the player does
not yet know what they have.

| Phase | Default | What happens |
|---|---|---|
| `armed` | — | the pack has slid in and is waiting to be tapped |
| `charge` | 620 ms | the pack swells and shakes, the seam lights, the rays start turning |
| `tear` | 440 ms | the top comes away and light spills out of the opening |
| `rise` | 540 ms | the card lifts out of the pack, still face down |
| `flip` | 760 ms | it turns over; the rarity burst fires on the same frame |
| `done` | — | the card is interactive, the band and the actions appear |

`pack.js` only advances `data-phase` on the scene; every visual response lives in `pack.css`.
Same split as `tilt.js`, so timing and look are tuned independently.

The card's art is preloaded and **decoded** during `armed` and `charge` via `preloadCards()`.
A reveal that shows a blank card and paints it a beat later is the one failure this screen
cannot survive. The preload is capped and never rejects: a slow CDN delays the art, it does not
hold the animation.

`prefers-reduced-motion` skips the theatre entirely — the card is simply there, face up, with
its band shown. That is a different code path in `open()`, not a slower animation.

## Artwork

Three sources, in precedence order:

| # | Source | When |
|---|---|---|
| 1 | **Player photo** — season-matched headshot | `node fetch-portraits.mjs`. Composited over a blurred champion splash. See the warning below. |
| 2 | **Champion splash** from Data Dragon | The default. Uses the card's signature champion — the one it played most that season, `championPool[0]`. |
| 3 | Generated SVG | Fallback when neither is available. |

Champion art is the right default rather than a compromise. Data Dragon is Riot's own CDN and
is the intended source for a community project, the art is genuinely good, and it carries real
information: seeing Ryze on Faker 2016 tells you what that card is for. A rarity wash
(`.lom-art__grade`, `mix-blend-mode: overlay`) sits over the splash so five different palettes
still read as one set.

### Player photos — read before shipping

Leaguepedia's `PlayerImages` table is excellent for this: headshots indexed by player **and
tournament**, so a 2016 card gets the 2016 photo. They are transparent cutouts, which is why
the composite works at all.

They are also **not freely licensed**. Every file checked carries a non-free template —
`Copyright fairuse`, `EsportsFairuse`, `Copyright game`. The site-wide CC BY-SA 3.0 covers
page text and explicitly not these. "Fair use" is a US defence judged per use: the wiki
identifying a player on their biography page is a different use from art on a collectible
card, and the claim does not transfer. The underlying photos are Riot/team press shots, and
depicted players hold personality rights in several jurisdictions.

For LOM as specified — private, invite-only, non-commercial, nothing purchasable
([docs/00 section 7](../../docs/00-vision-and-scope.md)) — that is a low-risk profile. It
stops being low-risk the moment the game is public or monetised.

`fetch-portraits.mjs` records the licence tag, source file and description URL for every
image in `assets/portraits/LICENCES.json`, and `build-demo.mjs` prints them on every build so
the position cannot be quietly forgotten. Delete `assets/portraits/` and every card falls back
to champion art with no code change.

**The image CDN rate-limits hard.** Expect some 403s; the fetcher backs off, skips files
already on disk, and never re-requests them. Do not work around a 403 by spoofing a browser
User-Agent — that is the host declining, and the correct response is to stop.

Cleanly licensed alternatives, if this ever goes public: Riot's own esports photography
(check current terms at the time), or commissioned/player-supplied images.

The generated fallback is seeded from the card key and composes a rarity-tinted radial ground,
a hex field, dashed orbital rings, light shafts from an off-centre origin, motes, the player's
initials at low opacity, a rim-lit bust and the role glyph. It has to look deliberate, because
it is what a card with no cleared art ships with.

### Asset resolution

`setAssetResolver()` swaps where art comes from without touching the template:

```js
import { setAssetResolver } from '@lom/card-engine';

// production: Supabase Storage, art synced by the pipeline
setAssetResolver({
  splash: (key) => `${CDN}/champion/splash/${key}.webp`,
  square: (key) => `${CDN}/champion/square/${key}.webp`,
  portrait: (cardKey) => clearedPortraits[cardKey] ?? null,
});
```

Pool chips take the 120x120 champion square; the art window takes the 1215x717 splash. Because
the window is narrower than the splash, the crop is horizontal — `artFocus` sets
`object-position` and only its X value matters.

Champion ids are Data Dragon's, not display names: `Lee Sin` is `LeeSin`, `LeBlanc` is
`Leblanc`. Cards carry `key` per pool entry (which is what `champion_key` holds in the real
schema); `championKey()` is only a fallback for hand-written data.

## Still to do

- Per-champion `artFocus` values. The current ones are eyeballed; several splashes crop better
  than others.
- Skin variants — `splash/{key}_{skinNum}.jpg` is right there, and a skin matching the
  player's team colours would be a cheap, good-looking card variant.
- Server-side render to PNG for share images (`docs/09-screens.md` section 12).
- Level/XP pip on the front once card levels exist.
- Multi-card packs: the phase machine takes one card today; five means a queue and a
  "next" affordance, not a new sequence.
- Production asset derivatives and the catalogue bundle described in
  [docs/11-card-assets-and-caching.md](../../docs/11-card-assets-and-caching.md). The resolver
  and `preloadCards()` are in place; nothing writes the derivatives yet.
- Port to `.ts` when this moves into `apps/web`.
