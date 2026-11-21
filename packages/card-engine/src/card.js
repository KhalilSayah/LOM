/**
 * Card construction: raw data in, a mounted card element out.
 *
 * Kept apart from index.js so that pack.js can build cards without importing the barrel,
 * which would make the two modules circular. index.js re-exports everything here.
 */

import { cardHtml } from './template.js';
import { attachTilt } from './tilt.js';
import { rarityForOvr } from './rarity.js';
import { championKey } from './assets.js';

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
  const pool = (card.championPool || []).map((c) => ({
    ...c,
    key: c.key || championKey(c.champion),
  }));

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
    artChampion: card.artChampion || signature?.champion || null,
    artChampionKey: card.artChampionKey || signature?.key || null,
    artFocus: card.artFocus || null,
  };
}

/**
 * Build one card element, wrapped in its sizing stage.
 * @param {object} card
 * @param {{maxTilt?:number, scale?:number, flip?:boolean, interactive?:boolean, compact?:boolean}} [opts]
 */
export function createCard(card, opts = {}) {
  const data = normaliseCard(card);
  const stage = document.createElement('div');
  stage.className = 'lom-stage';
  stage.innerHTML = cardHtml(data, { compact: opts.compact === true, interactive: opts.interactive !== false });
  const el = /** @type {HTMLElement} */ (stage.firstElementChild);
  const controller = opts.interactive === false ? null : attachTilt(el, opts);
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
