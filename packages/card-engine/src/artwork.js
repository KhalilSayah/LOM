/**
 * Procedural card artwork.
 *
 * docs/03-data-pipeline.md section 8.2 makes generated avatars the DEFAULT, because real
 * player photographs carry copyright and personality-rights exposure that a wiki text
 * licence does not clear. So this has to look deliberate, not like a missing image.
 *
 * Everything is seeded from the card key, so a card's art never changes.
 */

import { rngFor } from './rng.js';
import { RARITY_THEMES } from './rarity.js';

const W = 300;
const H = 208;

/** @param {string} name */
function initialsOf(name) {
  const cleaned = name.replace(/[^A-Za-z0-9 ]/g, '').trim();
  const parts = cleaned.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return cleaned.slice(0, 2).toUpperCase();
}

/** Role glyph, drawn at 0,0 in a 24x24 box. @param {string} role */
export function roleGlyph(role) {
  switch (role) {
    case 'TOP': // angled blade
      return 'M4 20 L14 4 L17 7 L9 21 Z M15 2 L21 8 L18 10 L13 5 Z';
    case 'JNG': // leaf / axe head
      return 'M12 2 C19 6 21 13 18 21 C10 21 4 16 4 9 C7 9 10 10 12 12 Z';
    case 'MID': // diamond
      return 'M12 2 L21 12 L12 22 L3 12 Z M12 7 L8 12 L12 17 L16 12 Z';
    case 'BOT': // crosshair arrow
      return 'M12 1 L14 7 L12 6 L10 7 Z M12 23 L10 17 L12 18 L14 17 Z M1 12 L7 10 L6 12 L7 14 Z M23 12 L17 14 L18 12 L17 10 Z M12 9 A3 3 0 1 1 11.99 9 Z';
    case 'SUP': // shield
      return 'M12 2 L21 6 V12 C21 17 17 21 12 22 C7 21 3 17 3 12 V6 Z M12 6 L7 8 V12 C7 15 9 17 12 18 C15 17 17 15 17 12 V8 Z';
    default:
      return 'M12 2 L21 12 L12 22 L3 12 Z';
  }
}

/**
 * Build the artwork SVG for a card.
 * @param {{cardKey:string, playerName:string, role:string, rarity:string}} card
 * @returns {string} SVG markup
 */
export function artworkSvg(card) {
  const rng = rngFor(card.cardKey);
  const theme = RARITY_THEMES[card.rarity] || RARITY_THEMES.COMMON;
  const uid = `a${Math.abs(hashLite(card.cardKey))}`;
  const initials = initialsOf(card.playerName);

  // --- light shafts, fanning from an off-centre origin above the frame
  const shaftOriginX = rng.range(90, 210);
  const shaftCount = rng.int(4, 6);
  let shafts = '';
  for (let i = 0; i < shaftCount; i++) {
    const spread = rng.range(-78, 78);
    const width = rng.range(14, 46);
    const x1 = shaftOriginX + spread;
    const x2 = x1 + rng.range(-70, 70);
    shafts += `<path d="M${x1.toFixed(1)} -20 L${(x1 + width).toFixed(1)} -20 L${(x2 + width * 2.4).toFixed(1)} ${H + 20} L${(x2 - width * 0.4).toFixed(1)} ${H + 20} Z" fill="url(#${uid}-shaft)" opacity="${rng.range(0.1, 0.3).toFixed(2)}"/>`;
  }

  // --- orbital rings behind the bust
  const ringCx = rng.range(130, 175);
  const ringCy = rng.range(78, 104);
  let rings = '';
  for (let i = 0; i < 3; i++) {
    const r = 48 + i * 22 + rng.range(-6, 6);
    rings += `<circle cx="${ringCx.toFixed(1)}" cy="${ringCy.toFixed(1)}" r="${r.toFixed(1)}" fill="none" stroke="${theme.artAccent}" stroke-opacity="${(0.22 - i * 0.05).toFixed(2)}" stroke-width="${(1.4 - i * 0.3).toFixed(2)}" stroke-dasharray="${rng.int(2, 10)} ${rng.int(3, 14)}"/>`;
  }

  // --- scatter motes
  let motes = '';
  for (let i = 0; i < 26; i++) {
    const x = rng.range(6, W - 6);
    const y = rng.range(6, H - 6);
    const r = rng.range(0.6, 2.1);
    motes += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}" fill="${theme.artAccent}" opacity="${rng.range(0.15, 0.6).toFixed(2)}"/>`;
  }

  // --- horizon line, sits behind the shoulders
  const horizon = (H * 0.72).toFixed(1);

  return `<svg class="lom-art__svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(card.playerName)} card artwork">
  <defs>
    <radialGradient id="${uid}-bg" cx="50%" cy="34%" r="78%">
      <stop offset="0%" stop-color="${theme.artA}"/>
      <stop offset="100%" stop-color="${theme.artB}"/>
    </radialGradient>
    <linearGradient id="${uid}-shaft" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${theme.artAccent}" stop-opacity="0.75"/>
      <stop offset="100%" stop-color="${theme.artAccent}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="${uid}-bust" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000" stop-opacity="0.26"/>
      <stop offset="60%" stop-color="#000" stop-opacity="0.72"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.9"/>
    </linearGradient>
    <linearGradient id="${uid}-rim" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${theme.artAccent}" stop-opacity="0.95"/>
      <stop offset="55%" stop-color="${theme.artAccent}" stop-opacity="0.15"/>
      <stop offset="100%" stop-color="${theme.artAccent}" stop-opacity="0.65"/>
    </linearGradient>
    <pattern id="${uid}-hex" width="24" height="41.6" patternUnits="userSpaceOnUse" patternTransform="scale(0.72)">
      <path d="M12 0 L24 6.93 V20.8 L12 27.7 L0 20.8 V6.93 Z" fill="none" stroke="${theme.artAccent}" stroke-opacity="0.13" stroke-width="1"/>
      <path d="M12 27.7 L24 34.6 V41.6 M12 27.7 L0 34.6 V41.6" fill="none" stroke="${theme.artAccent}" stroke-opacity="0.13" stroke-width="1"/>
    </pattern>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#${uid}-bg)"/>
  <rect width="${W}" height="${H}" fill="url(#${uid}-hex)"/>
  ${rings}
  ${shafts}
  ${motes}

  <line x1="0" y1="${horizon}" x2="${W}" y2="${horizon}" stroke="${theme.artAccent}" stroke-opacity="0.3" stroke-width="1"/>

  <text x="${(W / 2).toFixed(0)}" y="${(H * 0.63).toFixed(0)}" text-anchor="middle"
        font-family="'Chakra Petch','Arial Narrow',sans-serif" font-weight="700" font-size="112"
        fill="${theme.artAccent}" fill-opacity="0.16" letter-spacing="4">${esc(initials)}</text>

  <g transform="translate(${(W / 2 - 60).toFixed(0)}, 46)">
    <path d="M60 0 C78 0 92 14 92 33 C92 52 78 66 60 66 C42 66 28 52 28 33 C28 14 42 0 60 0 Z"
          fill="url(#${uid}-bust)"/>
    <path d="M60 60 C92 60 118 84 120 128 L120 162 L0 162 L0 128 C2 84 28 60 60 60 Z"
          fill="url(#${uid}-bust)"/>
    <path d="M60 0 C78 0 92 14 92 33 C92 52 78 66 60 66 C42 66 28 52 28 33 C28 14 42 0 60 0 Z
             M60 60 C92 60 118 84 120 128 L120 162 L0 162 L0 128 C2 84 28 60 60 60 Z"
          fill="none" stroke="url(#${uid}-rim)" stroke-width="1.6"/>
    <path d="M38 74 L60 96 L82 74" fill="none" stroke="${theme.artAccent}" stroke-opacity="0.5" stroke-width="1.6"/>
  </g>

  <g transform="translate(12, ${H - 34}) scale(0.95)" opacity="0.8">
    <path d="${roleGlyph(card.role)}" fill="${theme.artAccent}"/>
  </g>
</svg>`;
}

/** @param {string} s */
function hashLite(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}

/** @param {string} s */
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
