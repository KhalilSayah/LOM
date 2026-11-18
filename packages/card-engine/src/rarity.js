/**
 * Rarity themes. Each theme is a bundle of CSS custom properties plus a few
 * structural flags the template reads. Bands match docs/02-cards-and-collection.md.
 *
 * @typedef {'COMMON'|'RARE'|'EPIC'|'LEGENDARY'|'ICON'} Rarity
 */

export const RARITIES = /** @type {Rarity[]} */ ([
  'COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'ICON',
]);

/**
 * foil: which holographic treatment the front gets.
 *   none  - matte stock
 *   sheen - one moving specular band (silver)
 *   prism - diagonal spectral bands
 *   rainbow - full repeating spectrum + dodge blend
 *   prismatic - rainbow + animated hue drift + sparkle layer
 */
export const RARITY_THEMES = {
  COMMON: {
    label: 'Common',
    symbol: '●',
    band: [40, 67],
    foil: 'none',
    foilOpacity: 0,
    glarePower: 0.26,
    edge: '#49566b',
    frameA: '#20283a',
    frameB: '#161d2c',
    frameC: '#2b3448',
    accent: '#8fa3c0',
    ink: '#e4ebf6',
    glow: 'rgba(90,112,145,0.25)',
    artA: '#1d2435',
    artB: '#0e131f',
    artAccent: '#5d79a0',
  },
  RARE: {
    label: 'Rare',
    symbol: '◆',
    band: [68, 76],
    foil: 'sheen',
    foilOpacity: 0.4,
    glarePower: 0.4,
    edge: '#7fb6cf',
    frameA: '#24394a',
    frameB: '#13212e',
    frameC: '#3a6075',
    accent: '#67d3f2',
    ink: '#e8f6fb',
    glow: 'rgba(85,190,230,0.33)',
    artA: '#16303f',
    artB: '#0a1620',
    artAccent: '#58c4e6',
  },
  EPIC: {
    label: 'Epic',
    symbol: '✦',
    band: [77, 84],
    foil: 'prism',
    foilOpacity: 0.55,
    glarePower: 0.5,
    edge: '#b98ae8',
    frameA: '#352347',
    frameB: '#1d1130',
    frameC: '#55346f',
    accent: '#c08cff',
    ink: '#f3ebff',
    glow: 'rgba(170,110,245,0.4)',
    artA: '#2a1a40',
    artB: '#130c22',
    artAccent: '#a775f0',
  },
  LEGENDARY: {
    label: 'Legendary',
    symbol: '★',
    band: [85, 91],
    foil: 'rainbow',
    foilOpacity: 0.5,
    glarePower: 0.58,
    edge: '#e8c25f',
    frameA: '#473617',
    frameB: '#271c0c',
    frameC: '#6d5420',
    accent: '#f5cf6a',
    ink: '#fff6e0',
    glow: 'rgba(240,195,95,0.45)',
    artA: '#3a2a10',
    artB: '#171106',
    artAccent: '#e5b94f',
  },
  ICON: {
    label: 'Icon',
    symbol: '✧',
    band: [92, 99],
    foil: 'prismatic',
    foilOpacity: 0.58,
    glarePower: 0.66,
    edge: '#8ff0e4',
    frameA: '#10303a',
    frameB: '#07161d',
    frameC: '#1f6b72',
    accent: '#7df0dc',
    ink: '#eafffb',
    glow: 'rgba(110,240,220,0.5)',
    artA: '#0d3540',
    artB: '#050f16',
    artAccent: '#64e8d6',
  },
};

/**
 * Rarity from OVR + accolades. ICON requires both the band and an accolade.
 * @param {number} ovr
 * @param {string[]} [accolades]
 * @returns {Rarity}
 */
export function rarityForOvr(ovr, accolades = []) {
  const ICON_ACCOLADES = ['WORLDS_WINNER', 'INTERNATIONAL_FINALIST', 'SEASON_MVP', 'FINALS_MVP'];
  const hasIconAccolade = accolades.some((a) => ICON_ACCOLADES.includes(a));
  if (ovr >= 92 && hasIconAccolade) return 'ICON';
  if (ovr >= 85) return 'LEGENDARY';
  if (ovr >= 77) return 'EPIC';
  if (ovr >= 68) return 'RARE';
  return 'COMMON';
}

/**
 * Flatten a theme into inline CSS custom properties.
 * @param {Rarity} rarity
 */
export function themeVars(rarity) {
  const t = RARITY_THEMES[rarity];
  return [
    `--r-edge:${t.edge}`,
    `--r-frame-a:${t.frameA}`,
    `--r-frame-b:${t.frameB}`,
    `--r-frame-c:${t.frameC}`,
    `--r-accent:${t.accent}`,
    `--r-ink:${t.ink}`,
    `--r-glow:${t.glow}`,
    `--r-art-a:${t.artA}`,
    `--r-art-b:${t.artB}`,
    `--r-art-accent:${t.artAccent}`,
    `--r-foil-opacity:${t.foilOpacity}`,
    `--r-glare-power:${t.glarePower}`,
  ].join(';');
}
