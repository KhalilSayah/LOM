/**
 * Asset resolution and preloading.
 *
 * Champion art comes from Riot's Data Dragon CDN, which is the intended source for a
 * community project. The resolver is swappable so the same engine can run against:
 *   - the live CDN (dev, and the Nuxt app via a caching proxy)
 *   - Supabase Storage keys (production, per docs/06-architecture.md section 4)
 *   - inlined data URIs (the self-contained demo page, where the host blocks remote images)
 *
 * Player portraits deliberately have no default resolver. docs/03-data-pipeline.md section
 * 8.2 keeps them opt-in per cleared file; a card without one falls back to generated art.
 *
 * VARIANTS. A card asks for art by purpose, not by pixel size: 'card' for the full face,
 * 'thumb' for the collection grid. The resolver decides what that maps to. Data Dragon has
 * one size per image so both variants resolve to the same file there; in production they
 * resolve to different pre-rendered derivatives, which is what keeps the grid fast.
 * See docs/11-card-assets-and-caching.md for the sizes and the storage layout.
 */

export const DDRAGON_VERSION = { current: '16.22.1' };

/**
 * The derivative set the pipeline writes. These are the only sizes that exist in Storage;
 * asking for anything else means a cache miss and a resize at request time.
 * @type {Record<string, {w:number, h:number, fit:string, note:string}>}
 */
export const ART_VARIANTS = {
  card: { w: 420, h: 588, fit: 'cover', note: 'full card face at 2x of the 210pt print trim' },
  thumb: { w: 168, h: 235, fit: 'cover', note: 'collection grid at 2x of 84pt' },
  square: { w: 64, h: 64, fit: 'cover', note: 'champion pool tile at 2x of 32pt' },
  splash: { w: 1215, h: 717, fit: 'cover', note: 'the full landscape splash, detail views only' },
};

/** "Lee Sin" -> "LeeSin". Real cards carry champion_key from the pipeline; this is a fallback. */
export function championKey(name) {
  return String(name || '').replace(/[^A-Za-z0-9]/g, '');
}

const ddragon = {
  /**
   * Data Dragon has two sizes of champion art and the smaller one is the better fit:
   *
   *   splash   1215x717 landscape, ~145 KB — has to be cropped hard for a 63:88 card
   *   loading   308x560 portrait,   ~37 KB — already the shape of the card
   *
   * A pack reveal that waits on 145 KB is a pack reveal that shows an empty card, so the
   * card face takes the loading art and only an explicit 'splash' request gets the big one.
   * Production serves pre-sized WebP derivatives instead; see docs/11.
   */
  splash: (key, variant) => (variant === 'splash'
    ? `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${key}_0.jpg`
    : `https://ddragon.leagueoflegends.com/cdn/img/champion/loading/${key}_0.jpg`),
  square: (key) => `https://ddragon.leagueoflegends.com/cdn/${DDRAGON_VERSION.current}/img/champion/${key}.png`,
  // No default. A portrait only appears once a specific file has been cleared and
  // registered, which is the whole point of keeping this separate from champion art.
  portrait: () => null,
};

let resolver = ddragon;

/**
 * Replace the asset resolver. Any field left out falls back to the Data Dragon default.
 * Each function receives (key, variant) where variant is a key of ART_VARIANTS.
 * @param {{splash?:Function, square?:Function, portrait?:Function}} next
 */
export function setAssetResolver(next) {
  resolver = { ...ddragon, ...next };
}

/** @param {string} key @param {string} [variant] */
export function splashUrl(key, variant = 'card') {
  return key ? resolver.splash(key, variant) : null;
}

/** @param {string} key */
export function squareUrl(key) {
  return key ? resolver.square(key, 'square') : null;
}

/** @param {string} cardKey @param {string} [variant] */
export function portraitUrl(cardKey, variant = 'card') {
  return cardKey ? resolver.portrait(cardKey, variant) : null;
}

/**
 * Every image URL one card's front face will request, in the order it needs them.
 * @param {object} card a normalised card
 * @param {string} [variant]
 * @returns {string[]}
 */
export function cardImageUrls(card, variant = 'card', opts = {}) {
  const urls = [
    card.portraitUrl || portraitUrl(card.cardKey, variant),
    card.artUrl || splashUrl(card.artChampionKey, variant),
  ];
  // The pool tiles sit at the foot of the card behind a `loading="lazy"` attribute. They
  // are four more requests and nobody notices them arriving a beat late, so anything that
  // is waiting on art before it can proceed should not wait on these.
  if (!opts.essentialOnly) {
    urls.push(...(card.championPool || []).slice(0, 4)
      .map((c) => squareUrl(c.key || championKey(c.champion))));
  }
  return /** @type {string[]} */ (urls.filter(Boolean));
}

/**
 * Fetch and decode a card's art before it is shown.
 *
 * This is what makes a pack opening feel instant: the reveal animation runs for ~900ms,
 * and a card whose art decodes halfway through that pops in visibly. Call this while the
 * pack is still closed and the art is already in the decoded-image cache when the card
 * turns over. Never rejects — a missing image is a card that falls back to generated art,
 * not a broken opening.
 *
 * @param {object|object[]} cards one normalised card, or several
 * @param {{variant?:string, timeout?:number, essentialOnly?:boolean}} [opts]
 * @returns {Promise<{ok:number, failed:number}>}
 */
export function preloadCards(cards, opts = {}) {
  const variant = opts.variant || 'card';
  const timeout = opts.timeout ?? 6000;
  const list = Array.isArray(cards) ? cards : [cards];
  const urls = [...new Set(list.flatMap((c) => cardImageUrls(c, variant, opts)))];

  if (!urls.length || typeof Image === 'undefined') {
    return Promise.resolve({ ok: 0, failed: 0 });
  }

  let settled = 0;
  const one = (url) => new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    const done = (ok) => { settled++; resolve(ok); };
    img.onload = () => (img.decode ? img.decode().then(() => done(true), () => done(true)) : done(true));
    img.onerror = () => done(false);
    img.src = url;
  });

  const all = Promise.all(urls.map(one)).then((res) => ({
    ok: res.filter(Boolean).length,
    failed: res.filter((r) => !r).length,
  }));

  // A slow CDN must not hold the opening hostage; show the card and let it paint late.
  const cap = new Promise((resolve) => setTimeout(
    () => resolve({ ok: settled, failed: urls.length - settled }),
    timeout,
  ));

  return Promise.race([all, cap]);
}
