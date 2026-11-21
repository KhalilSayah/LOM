/**
 * @lom/card-engine — public surface.
 *
 * Written as plain ES modules with JSDoc types rather than TypeScript so the demo runs
 * with no build step. Ports to .ts unchanged when it moves into apps/web.
 */

export { hashString, mulberry32, rngFor } from './rng.js';
export { RARITIES, RARITY_THEMES, rarityForOvr, themeVars } from './rarity.js';
export { artworkSvg, roleGlyph } from './artwork.js';
export { cardHtml } from './template.js';
export { attachTilt, enableGyro } from './tilt.js';
export { setAssetResolver, splashUrl, squareUrl, portraitUrl, championKey, cardImageUrls, preloadCards, ART_VARIANTS, DDRAGON_IDS, DDRAGON_VERSION } from './assets.js';
export { championName, CHAMPION_NAMES } from './champions.js';
export { normaliseCard, createCard, mountCards } from './card.js';
export {
  normaliseText, queryTokens, cardMatches, sortCards, SORTS, RARITY_ORDER, groupSets,
  FILTER_DEFAULTS, readFilters, filtersToQuery, activeFilterCount, applyFilters, filterOptions,
} from './collection.js';
export { createPack, mountPack } from './pack.js';
