/**
 * Card construction: raw data in, a mounted card element out.
 *
 * Kept apart from index.js so that pack.js can build cards without importing the barrel,
 * which would make the two modules circular. index.js re-exports everything here.
 */

import { cardHtml } from './template.js';
import { attachTilt } from './tilt.js';
import { rarityForOvr } from './rarity.js';
import { championKey, championName } from './champions.js';
import { artworkSvg } from './artwork.js';

/**
 * Fill in anything the caller left out, so a card from the pipeline and a card typed by
 * hand in a test both render.
 * @param {object} card
 */
export function normaliseCard(card) {
  const subStats = Object.assign(
    { laning: 50, teamfight: 50, mechanics: 50, macro: 50, vision: 50, consistency: 50 },
    card.subStats || {},
  );
  // Keys are canonicalised and names put back into display form, so a row written as
  // "LeeSin" or "Wukong" by an older build still reads "Lee Sin" and finds its art.
  const pool = (card.championPool || []).map((c) => {
    const key = championKey(c.key || c.champion);
    return { ...c, key, champion: championName(c.champion || key) };
  });

  // The card's art defaults to its signature champion: the one it played most that season.
  const signature = pool[0];

  return {
    cardKey: card.cardKey || `${String(card.playerName || 'unknown').toLowerCase()}-${card.season || 0}`,
    playerName: card.playerName || 'Unknown',
    season: card.season || '—',
    team: card.team || 'Free agent',
    region: card.region || '—',
    role: card.role || 'MID',
    ovr: card.ovr ?? 50,
    rarity: card.rarity || rarityForOvr(card.ovr ?? 50, card.accolades),
    accolades: card.accolades || [],
    subStats,
    championPool: pool,
    seasonSummary: card.seasonSummary || {},
    provenance: card.provenance || '',

    // art, in precedence order: cleared photo -> explicit url -> signature champion -> generated
    portraitUrl: card.portraitUrl || null,
    artUrl: card.artUrl || null,
    artChampion: card.artChampion
      || (card.artChampionKey ? championName(card.artChampionKey) : signature?.champion) || null,
    artChampionKey: card.artChampionKey ? championKey(card.artChampionKey) : (signature?.key || null),
    artFocus: card.artFocus || null,
  };
}

/**
 * A picture that fails to load falls back instead of leaving a hole.
 *
 * The champion art falls back to the generated artwork — the same art a card with no
 * champion gets, so a CDN outage or a wrong id looks deliberate rather than broken. A pool
 * square falls back to the champion's initial. Listeners are attached synchronously after
 * the markup is written; an image's error event is always queued as a task, so none can
 * fire before they are in place.
 *
 * @param {HTMLElement} el the .lom-card
 * @param {object} data the normalised card
 */
function wireFallbacks(el, data) {
  const art = el.querySelector('.lom-art');
  const photo = el.querySelector('.lom-art__photo');
  const portrait = el.querySelector('.lom-art__portrait');

  if (photo && art) {
    photo.addEventListener('error', () => {
      // A cutout over generated art still works; only a lone splash needs replacing.
      if (portrait && portrait.isConnected) { photo.remove(); return; }
      art.className = 'lom-art lom-art--full';
      art.innerHTML = artworkSvg(data);
    }, { once: true });
  }
  if (portrait) {
    portrait.addEventListener('error', () => {
      portrait.remove();
      art?.classList.remove('lom-art--portrait');
    }, { once: true });
  }
  for (const img of el.querySelectorAll('.lom-pool__sq img, .lom-back__icon img')) {
    img.addEventListener('error', () => {
      const box = img.parentElement;
      if (!box) return;
      const cls = box.classList.contains('lom-pool__sq') ? 'lom-pool__sq' : 'lom-back__icon';
      box.classList.add(`${cls}--letter`);
      box.textContent = (img.dataset.champion || '?').slice(0, 1);
    }, { once: true });
  }
}

/**
 * Build one card element, wrapped in its sizing stage.
 *
 * `lite` is for grids of many cards that are looked at, not handled: no back face, no
 * foil, glare or sparkle layers, no 3D context and no blurred ground shadow. It is what
 * keeps a 300-card collection scrolling. It defaults to on for a compact card that is not
 * interactive, since such a card can never be turned over or tilted anyway.
 *
 * @param {object} card
 * @param {{maxTilt?:number, scale?:number, flip?:boolean, interactive?:boolean, compact?:boolean, lite?:boolean}} [opts]
 */
export function createCard(card, opts = {}) {
  const data = normaliseCard(card);
  const interactive = opts.interactive !== false;
  const compact = opts.compact === true;
  const lite = opts.lite ?? (compact && !interactive);
  const stage = document.createElement('div');
  stage.className = 'lom-stage';
  stage.innerHTML = cardHtml(data, { compact, interactive, lite });
  const el = /** @type {HTMLElement} */ (stage.firstElementChild);
  wireFallbacks(el, data);
  const controller = interactive ? attachTilt(el, opts) : null;
  return { stage, el, controller, data };
}

/**
 * Render a set of cards into a container.
 * @param {HTMLElement} container
 * @param {object[]} cards
 * @param {object} [opts]
 */
export function mountCards(container, cards, opts = {}) {
  const built = cards.map((c) => createCard(c, opts));
  for (const b of built) container.appendChild(b.stage);
  return built;
}
