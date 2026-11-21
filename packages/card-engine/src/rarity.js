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
    edge: '#5d6a80',
    frameA: '#1b2230',
    frameB: '#11161f',
    frameC: '#262f40',
    accent: '#9aa6ba',
    ink: '#f2ebdd',
    glow: 'rgba(154,166,186,0.22)',
    artA: '#1b2230',
    artB: '#0c1018',
    artAccent: '#7d8ba3',
  },
  RARE: {
    label: 'Rare',
    symbol: '◆',
    band: [68, 76],
    foil: 'sheen',
    foilOpacity: 0.4,
    glarePower: 0.4,
    edge: '#4fa8ff',
    frameA: '#13294a',
    frameB: '#0b1628',
    frameC: '#1d3d6b',
    accent: '#4fa8ff',
    ink: '#f2ebdd',
    glow: 'rgba(79,168,255,0.38)',
    artA: '#13294a',
    artB: '#081221',
    artAccent: '#4fa8ff',
  },
  EPIC: {
    label: 'Epic',
    symbol: '✦',
    band: [77, 84],
    foil: 'prism',
    foilOpacity: 0.55,
    glarePower: 0.5,
    edge: '#b583ff',
    frameA: '#2a1846',
    frameB: '#160c27',
    frameC: '#40246a',
    accent: '#b583ff',
    ink: '#f2ebdd',
    glow: 'rgba(181,131,255,0.42)',
    artA: '#2a1846',
    artB: '#120a20',
    artAccent: '#a774f2',
  },
  LEGENDARY: {
    label: 'Legendary',
    symbol: '★',
    band: [85, 91],
    foil: 'rainbow',
    foilOpacity: 0.5,
    glarePower: 0.58,
    edge: '#f2c14e',
    frameA: '#3a2a0c',
    frameB: '#1d1506',
    frameC: '#5c4313',
    accent: '#f2c14e',
    ink: '#f2ebdd',
    glow: 'rgba(242,193,78,0.46)',
    artA: '#3a2a0c',
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
    edge: '#a6f7ee',
    frameA: '#0d2f33',
    frameB: '#06171b',
    frameC: '#17575c',
    accent: '#a6f7ee',
    ink: '#f2ebdd',
    glow: 'rgba(166,247,238,0.48)',
    artA: '#0d3540',
    artB: '#050f16',
    artAccent: '#8cefe2',
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
