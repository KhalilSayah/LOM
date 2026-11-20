/**
 * Card markup. Front is the playable face; back carries the provenance line that
 * docs/09-screens.md section 5 makes non-negotiable.
 *
 * The front is a POSTER: the art is the card, full bleed, and the data sits on it in one
 * block along the bottom. That is the layout chosen in design review (direction B of five)
 * over the older framed-window layout, for three reasons:
 *   - the art reads before the text, which is what makes a card feel like a card
 *   - the player name and the SEASON share a baseline, so Faker 2016 and Faker 2026 are
 *     told apart at a glance — the season is half the identity, not a tag
 *   - it survives the collection grid: name, OVR and year still read at 132px
 *
 * Art precedence:
 *   1. portraitUrl   a cleared player photograph (opt-in, see docs/03 section 8.2)
 *   2. champion art  Data Dragon splash of the card's signature champion
 *   3. generated     the seeded SVG, which is what ships when neither is available
 */

import { artworkSvg, esc } from './artwork.js';
import { RARITY_THEMES, themeVars } from './rarity.js';
import { splashUrl, squareUrl, championKey, portraitUrl } from './assets.js';

const SUB_STATS = [
  ['laning', 'Laning', 'LANE'],
  ['teamfight', 'Teamfight', 'TFGT'],
  ['mechanics', 'Mechanics', 'MECH'],
  ['macro', 'Macro', 'MCRO'],
  ['vision', 'Vision', 'VISN'],
  ['consistency', 'Consistency', 'CONS'],
];

/** @param {number} v */
function barWidth(v) {
  // 40 is the practical floor of the scale; stretch 40-99 across the full bar.
  return Math.max(0, Math.min(100, ((v - 40) / 59) * 100)).toFixed(1);
}

/** @param {{champion:string, key?:string}} c */
function champIcon(c, cls) {
  const url = squareUrl(c.key || championKey(c.champion));
  if (!url) {
    return `<span class="${cls} ${cls}--letter">${esc(c.champion.slice(0, 1))}</span>`;
  }
  return `<span class="${cls}"><img src="${esc(url)}" alt="" loading="lazy" decoding="async"></span>`;
}

/** Front pool entry: the champion square with its mastery in the corner. */
function poolTile(c) {
  return `<li class="lom-pool__tile" title="${esc(c.champion)} — mastery ${c.mastery}">
    ${champIcon(c, 'lom-pool__sq')}
    <span class="lom-pool__m">${c.mastery}</span>
  </li>`;
}

/**
 * The art layers. On the poster face the art fills the whole card, so these layers are
 * the card's background rather than the contents of a window.
 *
 * With a portrait: the champion splash becomes a dimmed, blurred backdrop and the player
 * cutout is the subject. That is the composition a real sports card uses, and it is why
 * the headshots being alpha cutouts matters — over a flat colour they look like clip art.
 *
 * Without one: the splash is the art, sharp and full-bleed.
 *
 * @param {object} card
 */
function artLayers(card, variant) {
  const photo = card.portraitUrl || portraitUrl(card.cardKey, variant);
  const splash = card.artUrl || splashUrl(card.artChampionKey, variant);

  if (!photo && !splash) return { cls: '', html: artworkSvg(card) };

  const backdrop = splash
    ? `<img class="lom-art__photo" src="${esc(splash)}" alt="" loading="lazy" decoding="async"
        style="object-position:${esc(card.artFocus || '52% 30%')}">`
    : '';

  const subject = photo
    ? `<img class="lom-art__portrait" src="${esc(photo)}" alt="" loading="lazy" decoding="async">`
    : '';

  return {
    cls: photo ? ' lom-art--portrait' : '',
    html: `${backdrop}
      <span class="lom-art__grade" aria-hidden="true"></span>
      ${subject}`,
  };
}

/**
 * @param {object} card
 * @param {{compact?:boolean}} [opts] compact drops the meters, pool and footer for the
 *   collection grid, where below ~150px they are noise. Same markup, same code path.
 * @returns {string}
 */
export function cardHtml(card, opts = {}) {
  const theme = RARITY_THEMES[card.rarity] || RARITY_THEMES.COMMON;
  const pool = card.championPool || [];
  const compact = opts.compact === true;
  const art = artLayers(card, compact ? 'thumb' : 'card');

  // Two columns of six: label, value, and a meter rule that encodes the same number.
  const stats = SUB_STATS.map(([key, label, short]) => `
    <li class="lom-stat">
      <span class="lom-stat__label" title="${label}">${short}</span>
      <span class="lom-stat__val">${card.subStats[key]}</span>
      <span class="lom-stat__track"><span class="lom-stat__fill" style="width:${barWidth(card.subStats[key])}%"></span></span>
    </li>`).join('');

  const fullPool = pool.map((c) => `
    <li class="lom-back__pool-row">
      ${champIcon(c, 'lom-back__icon')}
      <span>${esc(c.champion)}</span>
      <span class="lom-back__dots" aria-hidden="true"></span>
      <span class="lom-back__pool-m">${c.mastery}</span>
      <span class="lom-back__pool-g">${c.games}g</span>
    </li>`).join('');

  const credit = card.artChampion
    ? `<span class="lom-art__champ">${esc(card.artChampion)}</span>`
    : '';

  return `<article class="lom-card${compact ? ' lom-card--compact' : ''}" data-rarity="${card.rarity}" data-foil="${theme.foil}"
    style="${themeVars(card.rarity)}" tabindex="0"
    aria-label="${esc(card.playerName)} ${card.season}, ${theme.label} card, overall ${card.ovr}">
  <div class="lom-card__inner">

    <div class="lom-card__face lom-card__face--front">
      <div class="lom-card__plate"></div>

      <div class="lom-art lom-art--full${art.cls}">
        ${art.html}
      </div>
      <div class="lom-card__scrim" aria-hidden="true"></div>

      <div class="lom-card__content">

        <header class="lom-head">
          <span class="lom-ovr"><b>${card.ovr}</b><i>${esc(card.role)}</i></span>
          <span class="lom-gem lom-gem--${String(card.rarity).toLowerCase()}" title="${theme.label}" aria-hidden="true"></span>
        </header>

        <div class="lom-panel">
          <p class="lom-meta"><span>${esc(card.team)}</span><i>/</i><span>${esc(card.region)}</span>${credit}</p>

          <div class="lom-id">
            <h3 class="lom-name">${esc(card.playerName)}</h3>
            <span class="lom-season">${card.season}</span>
          </div>

          <ul class="lom-stats">${stats}</ul>

          <ul class="lom-pool">${pool.slice(0, 4).map(poolTile).join('')}</ul>

          <footer class="lom-foot">
            <span class="lom-foot__rarity"><span class="lom-gem lom-gem--${String(card.rarity).toLowerCase()}" aria-hidden="true"></span>${theme.label}</span>
            <span class="lom-foot__key">${esc(card.cardKey)}</span>
            <span class="lom-foot__mark">LOM</span>
          </footer>
        </div>

      </div>

      <div class="lom-card__foil" aria-hidden="true"></div>
      <div class="lom-card__sparkle" aria-hidden="true"></div>
      <div class="lom-card__glare" aria-hidden="true"></div>
    </div>

    <div class="lom-card__face lom-card__face--back">
      <div class="lom-card__plate"></div>
      <div class="lom-back">
        <div class="lom-back__crest" aria-hidden="true">
          <svg viewBox="0 0 28 28"><path d="M14 2l12 12-12 12L2 14z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M14 7.5L20.5 14 14 20.5 7.5 14z" fill="currentColor"/></svg>
        </div>
        <h3 class="lom-back__title">${esc(card.playerName)} <b>${card.season}</b></h3>
        <p class="lom-back__sub">${esc(card.team)} · ${esc(card.region)} · ${esc(card.role)}</p>

        <h4 class="lom-back__h">Champion pool</h4>
        <ul class="lom-back__pool">${fullPool}</ul>

        <h4 class="lom-back__h">Season</h4>
        <dl class="lom-back__grid">
          ${Object.entries(card.seasonSummary || {}).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(String(v))}</dd></div>`).join('')}
        </dl>

        <p class="lom-back__prov">${esc(card.provenance || '')}</p>
        <span class="lom-back__mark">LOM · League of Managers</span>
      </div>
      <div class="lom-card__glare" aria-hidden="true"></div>
    </div>

  </div>
</article>`;
}
