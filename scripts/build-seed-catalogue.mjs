/**
 * Expand data/seed-players.json into a full catalogue: data/catalogue.seed.json.
 *
 *   node scripts/build-seed-catalogue.mjs
 *
 * The seed carries only the facts worth asserting by hand — who, when, which team, which
 * role, which champions, which trophies — plus one editorial OVR. Everything else (six
 * sub-stats, per-champion mastery, games, win rates, the season line) is derived here,
 * deterministically from the card key, so the same seed always produces the same catalogue
 * and a diff of this file is readable.
 *
 * None of the derived numbers are real. Every card carries provenance.source = 'SEED' and
 * the app prints it.
 *
 * The real catalogue comes from scripts/ingest-leaguepedia.mjs and scripts/build-catalogue.mjs,
 * which rate players from actual games. This file survives as the offline fixture docs/03
 * section 10 asks for: a committed seed expands into a runnable catalogue without anyone
 * downloading a gigabyte of match data first. It writes to its own path so a `catalogue:seed`
 * run can never overwrite a catalogue that was derived from real games.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rngFor } from '../packages/card-engine/src/rng.js';
import { rarityForOvr } from '../packages/card-engine/src/rarity.js';
import { championKey } from '../packages/card-engine/src/assets.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const SEMVER = process.env.CATALOGUE_SEMVER || buildSemver();

function buildSemver() {
  const d = new Date();
  return `${d.getUTCFullYear()}.${d.getUTCMonth() + 1}.${d.getUTCDate()}`;
}

/**
 * How a role bends the six sub-stats away from OVR. A support's vision is not his OVR, and
 * a bot laner's vision is emphatically not his OVR. Deltas sum to roughly zero per role so
 * the mean still tracks the rating.
 */
const ROLE_SHAPE = {
  TOP: { laning: +4, teamfight: -2, mechanics: +1, macro: 0, vision: -6, consistency: +3 },
  JNG: { laning: -7, teamfight: +1, mechanics: +2, macro: +6, vision: +4, consistency: -2 },
  MID: { laning: +4, teamfight: +1, mechanics: +4, macro: +1, vision: -6, consistency: -1 },
  BOT: { laning: +3, teamfight: +5, mechanics: +4, macro: -4, vision: -9, consistency: +1 },
  SUP: { laning: -5, teamfight: +2, mechanics: -4, macro: +3, vision: +9, consistency: -1 },
};

/** Season-line shape per role: [kdaBase, gd15Base, dpmBase]. */
const ROLE_LINE = {
  TOP: [2.9, 120, 460],
  JNG: [3.6, 60, 360],
  MID: [3.8, 150, 560],
  BOT: [4.4, 140, 640],
  SUP: [4.0, 40, 170],
};

const SUB_KEYS = ['laning', 'teamfight', 'mechanics', 'macro', 'vision', 'consistency'];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Champion display name from a Data Dragon key, for the few that are not literal. */
const CHAMP_NAMES = {
  Leblanc: 'LeBlanc',
  LeeSin: 'Lee Sin',
  RekSai: "Rek'Sai",
  Khazix: "Kha'Zix",
  Kaisa: "Kai'Sa",
  JarvanIV: 'Jarvan IV',
  XinZhao: 'Xin Zhao',
  TahmKench: 'Tahm Kench',
  TwistedFate: 'Twisted Fate',
  MonkeyKing: 'Wukong',
  KSante: "K'Sante",
  RenataGlasc: 'Renata Glasc',
  Chogath: "Cho'Gath",
  MasterYi: 'Master Yi',
  MissFortune: 'Miss Fortune',
  DrMundo: 'Dr. Mundo',
  AurelionSol: 'Aurelion Sol',
};

const champName = (key) => CHAMP_NAMES[key] || key;

/** Horizontal crop for the splash. Data Dragon art is 1215x717; only X matters. */
function artFocus(rng) {
  return `${rng.int(44, 56)}% 32%`;
}

function subStats(ovr, role, rng) {
  const shape = ROLE_SHAPE[role] || ROLE_SHAPE.MID;
  const out = {};
  for (const key of SUB_KEYS) {
    // Tie the spread to the rating: a 95 OVR is even, a 64 is lumpy.
    const spread = 8 - (ovr - 40) / 14;
    out[key] = clamp(Math.round(ovr + shape[key] + rng.range(-spread, spread)), 40, 99);
  }

  // Every card gets one dent and one spike. Without them the top of the catalogue is a wall
  // of 94-99 across six bars, which tells the player nothing and makes the radar a hexagon.
  // Faker 2016 is a 97 who warded like a 79, and that is the interesting part of the card.
  const weak = rng.pick(SUB_KEYS.filter((k) => shape[k] <= 1));
  const strong = rng.pick(SUB_KEYS.filter((k) => shape[k] >= 1));
  out[weak] = clamp(out[weak] - rng.int(7, 17), 40, 99);
  out[strong] = clamp(out[strong] + rng.int(1, 4), 40, 99);
  return out;
}

function championPool(keys, ovr, rng) {
  return keys.map((key, i) => {
    const decay = [0, 4, 9, 15, 20, 26][i] ?? 30;
    const mastery = clamp(Math.round(ovr + 3 - decay + rng.range(-3, 3)), 20, 100);
    const games = Math.max(3, Math.round((27 - decay * 0.85) * rng.range(0.75, 1.15)));
    const winrate = clamp(0.5 + (ovr - 76) / 160 + rng.range(-0.08, 0.1), 0.3, 0.85);
    return {
      // The hand-written keys in the table above are mostly Data Dragon ids already, but
      // a couple ("RenataGlasc") are not, and a wrong one shows a card with no picture.
      championKey: championKey(key),
      championName: champName(key),
      games,
      winrate: Number(winrate.toFixed(3)),
      mastery,
      slot: i,
    };
  });
}

function seasonSummary(ovr, role, pool, rng) {
  const [kdaBase, gd15Base, dpmBase] = ROLE_LINE[role] || ROLE_LINE.MID;
  const edge = (ovr - 76) / 20;
  const games = clamp(Math.round(pool.reduce((n, c) => n + c.games, 0) * rng.range(1.02, 1.18)), 24, 104);
  const kda = clamp(kdaBase + edge * 1.9 + rng.range(-0.4, 0.4), 1.2, 9.9);
  const gd15 = Math.round(gd15Base * edge + rng.range(-90, 90));
  const dpm = Math.round(dpmBase * (1 + edge * 0.14) + rng.range(-35, 35));
  return {
    Games: games,
    KDA: kda.toFixed(1),
    'GD@15': `${gd15 >= 0 ? '+' : ''}${gd15}`,
    DPM: dpm,
  };
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function buildCard(row) {
  const [playerName, season, team, region, role, ovr, accoladeStr, champStr] = row;
  const accolades = accoladeStr ? accoladeStr.split('|') : [];
  const champKeys = champStr.split(',').map((s) => s.trim()).filter(Boolean);

  const cardKey = `${slug(playerName)}-${season}`;
  const rng = rngFor(cardKey);

  const pool = championPool(champKeys, ovr, rng);
  const stats = subStats(ovr, role, rng);

  return {
    cardKey,
    kind: 'PLAYER',
    playerName,
    season,
    team,
    region,
    role,
    ovr,
    rarity: rarityForOvr(ovr, accolades),
    accolades,
    subStats: stats,
    championPool: pool,
    seasonSummary: seasonSummary(ovr, role, pool, rng),
    artChampionKey: pool[0]?.championKey || null,
    artFocus: artFocus(rng),
    provenance: {
      source: 'SEED',
      note: 'Editorial seed rating. Player, season, team, role, champions and accolades are '
        + 'real; sub-stats, mastery, games, win rates and the season line are generated from '
        + 'the card key and are not derived from match data.',
      catalogue: SEMVER,
    },
  };
}

// --- build -------------------------------------------------------------------

const seed = JSON.parse(readFileSync(join(root, 'data/seed-players.json'), 'utf8'));
const cards = seed.players.map(buildCard);

const byKey = new Map();
for (const c of cards) {
  if (byKey.has(c.cardKey)) {
    throw new Error(`duplicate card_key "${c.cardKey}" — a player-season appears twice in the seed`);
  }
  byKey.set(c.cardKey, c);
}

const bands = {};
const roles = {};
for (const c of cards) {
  bands[c.rarity] = (bands[c.rarity] || 0) + 1;
  roles[c.role] = (roles[c.role] || 0) + 1;
}

const catalogue = {
  semver: SEMVER,
  builtAt: new Date().toISOString(),
  source: 'SEED',
  notes: 'Highlights catalogue: famous player-seasons, editorial ratings. The band shares in '
    + 'docs/02 describe the full catalogue and do not hold here.',
  counts: { cards: cards.length, bands, roles },
  cards,
};

mkdirSync(join(root, 'data'), { recursive: true });
writeFileSync(join(root, 'data/catalogue.seed.json'), `${JSON.stringify(catalogue, null, 2)}\n`, 'utf8');

console.log(`built data/catalogue.seed.json — ${cards.length} cards, catalogue ${SEMVER}`);
console.log(`  bands  ${Object.entries(bands).map(([k, v]) => `${k} ${v}`).join('  ')}`);
console.log(`  roles  ${Object.entries(roles).map(([k, v]) => `${k} ${v}`).join('  ')}`);

for (const band of ['COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'ICON']) {
  if (!bands[band]) console.warn(`! no ${band} cards — packs will fall back to the next band down`);
}
