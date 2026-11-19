/**
 * Stages 2-6 of docs/03-data-pipeline.md: turn the raw bundles in .data/raw/ into a card
 * catalogue. Reads nothing but those files — no network, no API keys — so the rating
 * formula below can be rewritten and re-run in seconds.
 *
 *   node scripts/build-catalogue.mjs
 *   node scripts/build-catalogue.mjs --min-games 20 --strict
 *   node scripts/build-catalogue.mjs --in .data/raw --out data/catalogue.json
 *
 * Pull the bundles first with:  npm run ingest -- --years 2020..2026
 *
 * The chain, following docs/03 section 6:
 *   normalise  - one player-season per person per year, role and team from where they played
 *   aggregate  - tier-weighted means of ~15 metrics, all per minute against real game length
 *   rate       - z-scores inside a (role, year) cohort, blended into six sub-stats
 *   ovr        - role-weighted sum, accolade bonus capped at +4, percentile-mapped onto the
 *                docs/02 band shares so the catalogue's rarity mix comes out right by
 *                construction rather than by tuning cutoffs
 *   pool       - champion mastery from games, win rate and on-champion performance
 *   mint       - card rows, each carrying a provenance object naming its own limits
 *
 * Cohorts are per (role, year) on purpose. 2020 damage numbers are not 2026 damage numbers,
 * and a support is not a bot laner; pooling either would quietly rank eras and roles against
 * each other. The cost is that a rating is "strong for that role that season", not an
 * absolute, which is the trade docs/03 section 6.1 already chose.
 *
 * What this cannot do, because Leaguepedia's scoreboard does not carry it:
 *   - No gold/XP/CS difference at 15 minutes, so `laning` is a farm-and-economy proxy. For
 *     supports, who farm nothing, it falls back to involvement and survival, and is the
 *     weakest number on the card.
 *   - No wards placed or destroyed, so `vision` is vision score per minute alone.
 *   - No damage taken, so the support `teamfight` blend redistributes that weight.
 *   - No MVP awards anywhere in Cargo, so accolades stop at titles and finals.
 * Every one of those is named on the card itself. docs/03 section 11.1 is the way out: the
 * Oracle's Elixir columns would fill all four, once someone has the maintainer's permission.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rarityForOvr } from '../packages/card-engine/src/rarity.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const PIPELINE = 'lom-pipeline/0.2';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
// resolve, not join: --in and --out are often given as absolute paths, and joining one onto
// the repo root produces a path that cannot exist.
const IN_DIR = resolve(root, flag('in', '.data/raw'));
const OUT = resolve(root, flag('out', 'data/catalogue.json'));
const MIN_GAMES = Number(flag('min-games', '15'));
const MIN_ROLE_SHARE = 0.6;
// A season needs this many games at a domestic event that was actually pulled. Without it a
// minor-region player who only appears at Worlds gets a card built from a season nobody
// observed: the first build rated a PCS bot laner 97 off 33 international games, his PCS
// split being absent from a majors-only pull entirely.
const MIN_DOMESTIC_GAMES = Number(flag('min-domestic-games', '10'));
// Games of prior for the shrinkage in cohortZ(). See the comment there.
const VOLUME_PRIOR = Number(flag('volume-prior', '25'));
const STRICT = argv.includes('--strict');

// --- small helpers -----------------------------------------------------------

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Whether the source actually reported this column for this row.
 *
 * Leaguepedia's coverage is uneven by region and era, and the gaps are large: 56% of 2021
 * LPL rows carry no vision score, and 73% of every 2020 row carries no damage. Reading a
 * blank as 0 does not make a card slightly wrong, it makes it confidently wrong — the first
 * build rated Chinese players 24 points below everyone else on vision, when the LPL rows
 * that do report it average 48.7 against Europe's 48.6. There was no gap at all.
 *
 * So a blank is carried as missing all the way to the cohort, where it is excluded from the
 * mean and the deviation and scores a neutral z rather than a terrible one. A card whose
 * numbers rest on a column the source never provided says so in its provenance.
 *
 * Zero counts as missing too. A real game has no player on exactly zero gold, damage or
 * vision score, so a literal 0 in these columns is a placeholder, not an observation.
 */
const present = (v) => v !== '' && v != null && Number.isFinite(Number(v)) && Number(v) !== 0;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const champKey = (name) => String(name || '').replace(/[^A-Za-z0-9]/g, '');
const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
const modal = (map) => [...map.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

const warnings = [];
const warn = (msg) => { warnings.push(msg); console.warn(`! ${msg}`); };

// --- role ---------------------------------------------------------------------

const ROLES = ['TOP', 'JNG', 'MID', 'BOT', 'SUP'];
const ROLE_MAP = {
  top: 'TOP',
  jungle: 'JNG', jg: 'JNG', jng: 'JNG',
  mid: 'MID', middle: 'MID',
  bot: 'BOT', bottom: 'BOT', adc: 'BOT',
  support: 'SUP', sup: 'SUP',
};
const normRole = (r) => ROLE_MAP[String(r || '').trim().toLowerCase()] || null;

// --- tier weighting (docs/03 section 4) ---------------------------------------

const MAJORS = ['LCK', 'LPL', 'LEC', 'LCS', 'LTA', 'LCO', 'LMS'];
const isMajor = (page, league) => {
  const hay = `${page || ''} ${league || ''}`.toUpperCase();
  return MAJORS.some((m) => new RegExp(`\\b${m}\\b`).test(hay));
};

/**
 * 40 games of an easy minor split should not outrank 12 games at Worlds, so every game is
 * weighted by the event it was played at before any mean is taken.
 *
 * A Worlds play-in is scored as a normal major split, not as Worlds: the field is weaker
 * than the main event and it is not a minor-region tournament either.
 */
function tierOf(t) {
  if (t.isInternational) return t.isSideBracket ? { tier: 'MAJOR_REGULAR', weight: 1.0 } : { tier: 'INTERNATIONAL', weight: 1.35 };
  if (isMajor(t.page, t.league)) {
    return t.isPlayoffs || /Playoffs|Finals/i.test(t.page)
      ? { tier: 'MAJOR_PLAYOFF', weight: 1.15 }
      : { tier: 'MAJOR_REGULAR', weight: 1.0 };
  }
  return { tier: 'MINOR', weight: 0.8 };
}

/** Short label for the provenance line: "LCK", "Worlds", "MSI". */
function eventLabel(t) {
  const page = t.page || '';
  if (/World Championship/i.test(page)) return 'Worlds';
  if (/Mid-Season Invitational/i.test(page)) return 'MSI';
  if (/First Stand/i.test(page)) return 'First Stand';
  return page.split('/')[0];
}

/** Which accolade a placement at this event is worth (docs/03 section 6.3). */
function accoladesFor(t, place) {
  if (t.isSideBracket) return [];
  if (t.isInternational) {
    const isWorlds = /World Championship/i.test(`${t.page} ${t.league || ''}`);
    // MSI is an international title, not a world title. Conflating them puts WORLDS_WINNER
    // on the front of a card whose team did not win Worlds that year.
    if (place === 1) return isWorlds ? ['WORLDS_WINNER', 'INTERNATIONAL_FINALIST'] : ['INTERNATIONAL_FINALIST'];
    if (place === 2) return ['INTERNATIONAL_FINALIST'];
    return [];
  }
  // A domestic title means winning the split, not topping the regular season it seeded.
  if (place === 1 && (t.isPlayoffs || /Playoffs|Season Finals|Finals/i.test(t.page))) return ['DOMESTIC_TITLE'];
  return [];
}

const ACCOLADE_BONUS = {
  WORLDS_WINNER: 3.0,
  INTERNATIONAL_FINALIST: 2.0,
  DOMESTIC_TITLE: 1.0,
};
const ACCOLADE_CAP = 4.0;

// --- weighted statistics ------------------------------------------------------

function weightedMean(values, weights) {
  const w = sum(weights);
  return w > 0 ? sum(values.map((v, i) => v * weights[i])) / w : 0;
}

function weightedStdev(values, weights, mean) {
  const w = sum(weights);
  if (w <= 0) return 0;
  return Math.sqrt(sum(values.map((v, i) => weights[i] * (v - mean) ** 2)) / w);
}

function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = sum(xs) / xs.length;
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / xs.length);
}

/** Percentile of each value within its own array, 0..1, ties sharing the lower rank. */
function percentiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return values.map((v) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < v) lo = mid + 1; else hi = mid;
    }
    return sorted.length < 2 ? 0.5 : lo / (sorted.length - 1);
  });
}

/** docs/02 section 3 band shares, as a piecewise map from percentile to OVR. */
const BANDS = [
  [0.450, 40, 67],
  [0.300, 68, 76],
  [0.170, 77, 84],
  [0.065, 85, 91],
  [0.015, 92, 99],
];

function ovrFromPercentile(p) {
  let acc = 0;
  for (let i = 0; i < BANDS.length; i++) {
    const [share, lo, hi] = BANDS[i];
    // The last band absorbs any rounding residue at the top of the range, so a percentile
    // of exactly 1 still lands inside a band rather than falling out of the loop.
    if (p <= acc + share || i === BANDS.length - 1) {
      return Math.round(lo + clamp((p - acc) / share, 0, 1) * (hi - lo));
    }
    acc += share;
  }
  return 40;
}

// --- sub-stat blends ----------------------------------------------------------

/**
 * docs/03 section 6.2, with the inputs this source actually has. Where a metric the doc
 * names is missing its weight is redistributed across the remaining terms of that blend
 * rather than silently dropped, so every blend still sums to 1 and a missing column makes a
 * sub-stat vaguer rather than smaller.
 *
 * `laning` is the compromise. The doc builds it entirely from gold/XP/CS differences at 15
 * minutes, none of which exist here, so what is measured is farm and economy for the four
 * farming roles and involvement for supports. The provenance on every card says so.
 */
const BLENDS = {
  TOP: {
    laning: { cspm: 0.45, gpm: 0.35, goldShare: 0.20 },
    teamfight: { dpm: 0.45, dmgShare: 0.35, kp: 0.20 },
    mechanics: { goldEff: 0.40, invDeaths: 0.35, kda: 0.25 },
    macro: { towers: 0.40, cspm: 0.30, objectives: 0.30 },
    vision: { vspm: 1.0 },
    consistency: { steadiness: 0.70, volume: 0.30 },
  },
  JNG: {
    laning: { gpm: 0.45, cspm: 0.35, kp: 0.20 },
    teamfight: { dpm: 0.35, dmgShare: 0.25, kp: 0.40 },
    mechanics: { goldEff: 0.35, invDeaths: 0.35, kda: 0.30 },
    macro: { objectives: 0.50, towers: 0.30, gpm: 0.20 },
    vision: { vspm: 1.0 },
    consistency: { steadiness: 0.70, volume: 0.30 },
  },
  MID: {
    laning: { cspm: 0.45, gpm: 0.35, goldShare: 0.20 },
    teamfight: { dpm: 0.45, dmgShare: 0.35, kp: 0.20 },
    mechanics: { goldEff: 0.40, invDeaths: 0.35, kda: 0.25 },
    macro: { towers: 0.40, cspm: 0.30, objectives: 0.30 },
    vision: { vspm: 1.0 },
    consistency: { steadiness: 0.70, volume: 0.30 },
  },
  BOT: {
    laning: { cspm: 0.45, gpm: 0.35, goldShare: 0.20 },
    teamfight: { dpm: 0.50, dmgShare: 0.35, kp: 0.15 },
    mechanics: { goldEff: 0.45, invDeaths: 0.30, kda: 0.25 },
    macro: { towers: 0.35, cspm: 0.35, objectives: 0.30 },
    vision: { vspm: 1.0 },
    consistency: { steadiness: 0.70, volume: 0.30 },
  },
  SUP: {
    // The doc's support laning is .55 gd15 + .45 xpd15. With no lane stats at all, staying
    // alive and being in the action is the closest honest reading of a support's early game.
    laning: { kp: 0.50, invDeaths: 0.50 },
    // The doc spends .25 here on damage taken, which this source does not carry.
    teamfight: { kp: 0.45, vspm: 0.35, dmgShare: 0.20 },
    mechanics: { invDeaths: 0.40, kda: 0.35, goldEff: 0.25 },
    macro: { objectives: 0.45, towers: 0.35, vspm: 0.20 },
    vision: { vspm: 1.0 },
    consistency: { steadiness: 0.70, volume: 0.30 },
  },
};

/** docs/03 section 6.3. */
const OVR_WEIGHTS = {
  TOP: { laning: 0.26, teamfight: 0.24, mechanics: 0.22, macro: 0.16, vision: 0.04, consistency: 0.08 },
  JNG: { laning: 0.12, teamfight: 0.22, mechanics: 0.20, macro: 0.30, vision: 0.08, consistency: 0.08 },
  MID: { laning: 0.24, teamfight: 0.28, mechanics: 0.22, macro: 0.14, vision: 0.04, consistency: 0.08 },
  BOT: { laning: 0.24, teamfight: 0.34, mechanics: 0.22, macro: 0.10, vision: 0.02, consistency: 0.08 },
  SUP: { laning: 0.14, teamfight: 0.22, mechanics: 0.14, macro: 0.20, vision: 0.22, consistency: 0.08 },
};

const SUB_KEYS = ['laning', 'teamfight', 'mechanics', 'macro', 'vision', 'consistency'];

/** Metrics that are better when lower are inverted at source, so every z-score points up. */
const METRICS = [
  'dpm', 'gpm', 'cspm', 'vspm', 'kp', 'dmgShare', 'goldShare',
  'invDeaths', 'kda', 'goldEff', 'towers', 'objectives', 'steadiness', 'volume',
];

// --- 1. aggregate one year ----------------------------------------------------

function aggregateYear(bundle) {
  const tByPage = new Map(bundle.tournaments.map((t) => [t.page, t]));

  // Game headers carry the one thing the scoreboard lacks: how long the game ran. Without a
  // duration every rate stat would be per game, which flatters whoever played slowly.
  const gameByPage = new Map();
  for (const g of bundle.games) gameByPage.set(`${g.Page}\u0000${g.GameId}`, g);

  // Damage share needs the team's damage, which is not a column anywhere — it is the sum of
  // the five scoreboard rows for that team in that game.
  const teamDamage = new Map();
  for (const r of bundle.rows) {
    if (!r.Team || !r.GameId || !present(r.DamageToChampions)) continue;
    const key = `${r.Page}\u0000${r.GameId}\u0000${r.Team}`;
    const e = teamDamage.get(key) || { total: 0, rows: 0 };
    e.total += num(r.DamageToChampions);
    e.rows += 1;
    teamDamage.set(key, e);
  }

  // Who won what. Placements are per tournament; a player collects the accolade if their
  // modal team for that event placed.
  const titleTeams = new Map();
  for (const [page, places] of Object.entries(bundle.results || {})) {
    const t = tByPage.get(page);
    if (!t) continue;
    for (const row of places) {
      const place = Number(row.Place);
      if (place !== 1 && place !== 2) continue;
      const won = accoladesFor(t, place);
      if (won.length) titleTeams.set(`${page}\u0000${row.Team}`, won);
    }
  }

  const byPlayer = new Map();
  let noLength = 0;
  let total = 0;

  for (const r of bundle.rows) {
    const link = r.Link;
    const role = normRole(r.Role);
    if (!link || !role) continue;
    const t = tByPage.get(r.Page);
    if (!t) continue;

    total++;
    const g = gameByPage.get(`${r.Page}\u0000${r.GameId}`);
    const minutes = num(g?.LengthMin);
    const hasLength = minutes > 5;
    if (!hasLength) noLength++;

    const { tier, weight } = tierOf(t);

    let a = byPlayer.get(link);
    if (!a) {
      a = {
        link,
        year: bundle.year,
        games: 0,
        domestic: 0,
        weighted: 0,
        wins: 0,
        // Raw season totals, kept only for the box score on the card back. The season KDA a
        // fan recognises is (total kills + assists) / total deaths, not the mean of each
        // game's ratio — that mean is inflated by every deathless game, which divides by 1.
        totals: { k: 0, d: 0, a: 0 },
        roles: new Map(),
        teams: new Map(),
        regions: new Map(),
        events: new Map(),
        tiers: new Map(),
        accolades: new Set(),
        champs: new Map(),
        composites: [],
        // Per-metric observations and their tier weights, so every mean below is a
        // tier-weighted mean of real games. Each metric keeps its own arrays because they
        // do not all have the same number of observations: a row missing its damage still
        // contributes a vision score, and vice versa.
        raw: Object.fromEntries(METRICS.map((m) => [m, []])),
        wts: Object.fromEntries(METRICS.map((m) => [m, []])),
      };
      byPlayer.set(link, a);
    }

    const kills = num(r.Kills);
    const deaths = num(r.Deaths);
    const assists = num(r.Assists);
    const gold = num(r.Gold);
    const cs = num(r.CS);
    const hasDamage = present(r.DamageToChampions);
    const hasVision = present(r.VisionScore);
    const damage = num(r.DamageToChampions);
    const vision = num(r.VisionScore);
    const teamKills = num(r.TeamKills);
    const teamGold = num(r.TeamGold);

    // Damage share is only meaningful when the whole team's damage was reported. With a
    // partial team the denominator is too small and the players who do have a number look
    // like they did far more of the work than they did.
    const team = teamDamage.get(`${r.Page}\u0000${r.GameId}\u0000${r.Team}`);
    const tDmg = team && team.rows === 5 ? team.total : 0;

    const kp = teamKills > 0 ? (kills + assists) / teamKills : null;
    const dmgShare = hasDamage && tDmg > 0 ? damage / tDmg : null;
    const goldShare = teamGold > 0 ? gold / teamGold : null;
    const win = r.PlayerWin === 'Yes';

    // Which side the player was on, so team objectives can be read off the game header.
    // Matching the team name is safer than trusting the side column, which is sometimes
    // blank on older pages.
    let towers = null;
    let objectives = null;
    if (g) {
      const side = g.Team1 === r.Team ? 1 : g.Team2 === r.Team ? 2 : (r.Side === '1' ? 1 : r.Side === '2' ? 2 : 0);
      if (side) {
        towers = num(g[`Team${side}Towers`]);
        objectives = num(g[`Team${side}Barons`]) + num(g[`Team${side}Dragons`]);
      }
    }

    a.games += 1;
    if (!t.isInternational) a.domestic += 1;
    a.weighted += weight;
    a.wins += win ? 1 : 0;
    a.totals.k += kills;
    a.totals.d += deaths;
    a.totals.a += assists;
    bump(a.roles, role, weight);
    if (r.Team) bump(a.teams, r.Team, weight);
    // Region is read from domestic events only; every international event is filed under
    // "International", which would otherwise rewrite a Worlds regular's home region.
    if (t.region && !t.isInternational) bump(a.regions, t.region, weight);
    bump(a.events, eventLabel(t), 1);
    bump(a.tiers, tier, 1);

    const titles = titleTeams.get(`${r.Page}\u0000${r.Team}`);
    if (titles) for (const acc of titles) a.accolades.add(acc);

    if (r.Champion) {
      const c = a.champs.get(r.Champion) || { games: 0, wins: 0, composites: [] };
      c.games += 1;
      c.wins += win ? 1 : 0;
      a.champs.set(r.Champion, c);
    }

    /** Record one observation of a metric, skipping it when the source did not report it. */
    const obs = (metric, value) => {
      if (value == null || !Number.isFinite(value)) return;
      a.raw[metric].push(value);
      a.wts[metric].push(weight);
    };

    // A scale-free per-game score, in shares rather than raw totals, so its spread across a
    // season means the same thing for a 2020 support as for a 2026 bot laner. Its standard
    // deviation is what `consistency` is built from (docs/03 section 5, Variance). It is
    // only recorded for games where every part of it was reported, so a season of partial
    // rows reads as fewer observations rather than as wild swings.
    if (kp != null && dmgShare != null && goldShare != null) {
      const composite = 0.35 * kp + 0.30 * dmgShare + 0.20 * goldShare + 0.15 * (win ? 1 : 0);
      a.composites.push(composite);
      if (r.Champion) a.champs.get(r.Champion).composites.push(composite);
    }

    obs('kp', kp);
    obs('dmgShare', dmgShare);
    obs('goldShare', goldShare);
    obs('invDeaths', -deaths);
    obs('kda', (kills + assists) / Math.max(1, deaths));
    obs('towers', towers);
    obs('objectives', objectives);

    // Rate stats need a duration; everything expressed as a share or a count does not.
    if (hasLength) {
      const gpm = gold / minutes;
      obs('gpm', gpm);
      obs('cspm', cs / minutes);
      if (hasDamage) {
        obs('dpm', damage / minutes);
        obs('goldEff', gpm > 0 ? damage / minutes / gpm : null);
      }
      if (hasVision) obs('vspm', vision / minutes);
    }
  }

  if (total && noLength / total > 0.05) {
    warn(`${bundle.year}: ${Math.round((noLength / total) * 100)}% of scoreboard rows have no `
      + 'game header, so their per-minute stats are excluded. Shares, KDA and win rate still '
      + 'count them.');
  }

  return byPlayer;
}

/** Collapse the per-game arrays into one tier-weighted number per metric. */
/**
 * Collapse the per-game observations into one tier-weighted number per metric. A metric the
 * source never reported for this player stays null rather than becoming 0, so the cohort can
 * leave it out instead of ranking the player last on a column nobody measured.
 */
function finalise(a) {
  const metrics = {};
  for (const m of METRICS) {
    if (m === 'steadiness' || m === 'volume') continue;
    metrics[m] = a.raw[m].length ? weightedMean(a.raw[m], a.wts[m]) : null;
  }
  // A player with 18 games has not demonstrated consistency whatever their variance looks
  // like, which is why docs/03 section 6.2 blends volume into it.
  metrics.steadiness = a.composites.length >= 5 ? -stdev(a.composites) : null;
  metrics.volume = Math.min(1, a.weighted / 40);
  // Named on the card, so a reader can see which numbers rest on a column the source did
  // not carry for them.
  a.incomplete = METRICS.filter((m) => metrics[m] == null);
  return metrics;
}

// --- 1b. how strong was each league that season -------------------------------

/**
 * Measure each region's season by what its teams did against other regions, and use it to
 * correct ratings for the strength of the league a player farmed their numbers in.
 *
 * Why this is needed at all: cohorts are (role, season) pooled across regions, so a player
 * is z-scored against every region at once. A weaker league produces longer, looser games
 * and therefore better-looking per-minute numbers, and the first build showed it plainly —
 * North American players lifted 1.38x into the catalogue's top 100 while Chinese players
 * lifted 0.65x, in seasons where the LPL was the deepest league in the world.
 *
 * Why it is not done through the tier weight in tierOf(): scaling every one of a player's
 * games by the same factor leaves their weighted mean exactly where it was. A region term
 * has to move the rating itself, which is what applyRegionStrength() below does.
 *
 * The measure is the region's win rate in cross-region games at Worlds and MSI, shrunk
 * toward even by a 10-game prior because a region plays only a few dozen such games a year.
 * Nothing here is hand-set: a league is strong in a season because its teams beat other
 * leagues in that season.
 */
function regionStrength(bundle, tByPage) {
  // Which region each team belongs to, learned from the domestic events they played.
  const teamRegions = new Map();
  for (const r of bundle.rows) {
    const t = tByPage.get(r.Page);
    if (!t || t.isInternational || !t.region || !r.Team) continue;
    if (!teamRegions.has(r.Team)) teamRegions.set(r.Team, new Map());
    bump(teamRegions.get(r.Team), t.region);
  }
  const regionOf = (team) => {
    const m = teamRegions.get(team);
    return m ? modal(m) : null;
  };

  const record = new Map();
  const note = (region, won) => {
    if (!record.has(region)) record.set(region, { games: 0, wins: 0 });
    const rec = record.get(region);
    rec.games += 1;
    rec.wins += won ? 1 : 0;
  };

  for (const g of bundle.games) {
    const t = tByPage.get(g.Page);
    if (!t || !t.isInternational) continue;
    const r1 = regionOf(g.Team1);
    const r2 = regionOf(g.Team2);
    // Only cross-region games say anything about which league is stronger.
    if (!r1 || !r2 || r1 === r2) continue;
    note(r1, g.WinTeam === g.Team1);
    note(r2, g.WinTeam === g.Team2);
  }

  const PRIOR = 10;
  const strength = new Map();
  for (const [region, rec] of record) {
    const shrunk = (rec.wins + 0.5 * PRIOR) / (rec.games + PRIOR);
    strength.set(region, { winrate: shrunk, games: rec.games, raw: rec.wins / rec.games });
  }
  return strength;
}

/**
 * Turn a region's cross-region win rate into OVR points, centred on even. A spread of 10
 * means a region that wins 75% of its cross-region games lifts its players by 2.5 points of
 * raw OVR and one that wins 25% loses 2.5. A region with no international games that season
 * is left alone rather than guessed at.
 *
 * Deliberately modest, because most of what looked like a regional bias was not one. Before
 * missing columns were separated from zeroes, North American players lifted 1.38x into the
 * catalogue's top 100 and Chinese players 0.65x; fixing that alone moved them to 0.97x and
 * 1.02x with no region term at all. What is left is a real but small effect, and turning
 * this up far enough to be dramatic mostly just buries the LEC. Pass --region-spread 0 to
 * switch it off and compare.
 */
const REGION_SPREAD = Number(flag('region-spread', '10'));
const regionAdjustment = (strength, region) => {
  const s = region ? strength.get(region) : null;
  return s ? REGION_SPREAD * (s.winrate - 0.5) : 0;
};

// --- 2. rate a cohort ---------------------------------------------------------

/**
 * z-scores inside one (role, year) cohort, weighted by how many weighted games each member
 * played, clamped to +/-3 so one freak season cannot drag the whole cohort's scale.
 */
function cohortZ(members, metrics) {
  const weights = members.map((m) => m.weighted);

  /**
   * How far to trust each player's own numbers, by how many games are behind them.
   *
   * A 15-game season is mostly noise: the first build put a T1 substitute who played exactly
   * the inclusion floor at OVR 98, above two Worlds winners with 144 games each. Pulling
   * every z-score toward the cohort mean in proportion to sample size fixes that without a
   * hard cutoff — a short season reads as "unproven", which is average, rather than as
   * whatever its handful of games happened to say.
   *
   * sqrt(n / (n + 25)): 15 games keeps 61% of its z, 40 keeps 78%, 100 keeps 89%.
   */
  const trust = members.map((m) => Math.sqrt(m.weighted / (m.weighted + VOLUME_PRIOR)));

  const z = new Map();
  for (const metric of METRICS) {
    const values = members.map((m) => metrics.get(m.link)[metric]);

    // The cohort's mean and deviation come only from the players the source actually
    // reported this metric for. Including the others as zeroes would drag the mean down and
    // inflate the spread, which is how a missing column becomes everyone else's problem too.
    const seen = values.map((v, i) => [v, weights[i]]).filter(([v]) => v != null);
    const mean = weightedMean(seen.map((s) => s[0]), seen.map((s) => s[1]));
    const sd = weightedStdev(seen.map((s) => s[0]), seen.map((s) => s[1]), mean);

    // `volume` is the measure of sample size itself, so shrinking it by sample size would
    // say a player with few games is of average volume, which is exactly backwards.
    const shrink = metric !== 'volume';
    const column = values.map((v, i) => {
      // Unmeasured is neutral, not bad.
      if (v == null || sd <= 1e-9) return 0;
      return clamp((v - mean) / sd, -3, 3) * (shrink ? trust[i] : 1);
    });
    z.set(metric, column);
  }
  return z;
}

const blend = (spec, z, i) =>
  Object.entries(spec).reduce((acc, [metric, w]) => acc + w * (z.get(metric)?.[i] ?? 0), 0);

const statFromZ = (zv) => Math.round(clamp(50 + 14 * zv, 1, 99));

// --- 3. champion pool (docs/03 section 7) -------------------------------------

function championPool(a) {
  const seasonMean = a.composites.length ? sum(a.composites) / a.composites.length : 0;
  const seasonSd = stdev(a.composites);

  return [...a.champs.entries()]
    .filter(([, c]) => c.games >= 2)
    .sort((x, y) => y[1].games - x[1].games || x[0].localeCompare(y[0]))
    .slice(0, 15)
    .map(([name, c], slot) => {
      const winrate = c.wins / c.games;
      const base = 100 * c.games / (c.games + 6);
      const wrAdj = (winrate - 0.5) * 40;
      const champMean = c.composites.length ? sum(c.composites) / c.composites.length : seasonMean;
      const perfAdj = seasonSd > 1e-9 ? clamp(((champMean - seasonMean) / seasonSd) * 8, -12, 12) : 0;
      return {
        championKey: champKey(name),
        championName: name,
        games: c.games,
        winrate: Number(winrate.toFixed(3)),
        mastery: Math.round(clamp(base + wrAdj + perfAdj, 10, 100)),
        slot,
      };
    });
}

// --- 4. build ------------------------------------------------------------------

if (!existsSync(IN_DIR)) {
  console.error(`no raw bundles at ${IN_DIR}\n\nPull some first:  npm run ingest -- --years 2020..2026`);
  process.exit(1);
}

const files = readdirSync(IN_DIR).filter((f) => /^leaguepedia-\d{4}\.json$/.test(f)).sort();
if (!files.length) {
  console.error(`no leaguepedia-{year}.json bundles in ${IN_DIR}\n\nPull some first:  npm run ingest -- --years 2020..2026`);
  process.exit(1);
}

console.log(`in      ${IN_DIR} (${files.length} year bundles)`);
console.log(`floor   ${MIN_GAMES} weighted games, ${Math.round(MIN_ROLE_SHARE * 100)}% in one role\n`);

const cards = [];
/** Every rated player-season, held back until all years are in so one ranking can cover them. */
const rated = [];
const sourceHashes = {};
const coveredYears = [];
const SEMVER = process.env.CATALOGUE_SEMVER || null;

for (const file of files) {
  const text = readFileSync(join(IN_DIR, file), 'utf8');
  const bundle = JSON.parse(text);
  coveredYears.push(bundle.year);
  sourceHashes[file] = createHash('sha256').update(text).digest('hex').slice(0, 16);

  const realNames = new Map();
  for (const p of bundle.players || []) {
    realNames.set(p.OverviewPage, { handle: p.ID || null, name: p.Name || null, country: p.Country || null });
  }

  const byPlayer = aggregateYear(bundle);

  // Inclusion, docs/03 section 5: enough games to mean anything, and enough of them in one
  // role to call the player that role. Someone who split a year between jungle and support
  // is unclassifiable rather than bad, so they get no card at all.
  const kept = [];
  let thinGames = 0;
  let roleSplit = 0;
  let partlySeen = 0;
  for (const a of byPlayer.values()) {
    if (a.weighted < MIN_GAMES) { thinGames++; continue; }
    if (a.domestic < MIN_DOMESTIC_GAMES) { partlySeen++; continue; }
    const top = modal(a.roles);
    const share = a.roles.get(top) / sum([...a.roles.values()]);
    if (share < MIN_ROLE_SHARE) { roleSplit++; continue; }
    a.role = top;
    // Region comes from domestic events only; every international event is filed under
    // "International", which would otherwise erase the home league this corrects for.
    a.region = modal(a.regions);
    kept.push(a);
  }

  const strength = regionStrength(bundle, new Map(bundle.tournaments.map((t) => [t.page, t])));
  for (const [region, s] of [...strength].sort((x, y) => y[1].winrate - x[1].winrate)) {
    console.log(`  ${String(region).padEnd(15)} ${(s.raw * 100).toFixed(0).padStart(3)}% of `
      + `${String(s.games).padStart(3)} cross-region games -> `
      + `${regionAdjustment(strength, region) >= 0 ? '+' : ''}${regionAdjustment(strength, region).toFixed(1)} OVR`);
  }

  const metrics = new Map(kept.map((a) => [a.link, finalise(a)]));

  let yearCards = 0;
  for (const role of ROLES) {
    const cohort = kept.filter((a) => a.role === role);
    if (!cohort.length) continue;
    if (cohort.length < 20) {
      warn(`${bundle.year} ${role}: cohort of ${cohort.length}. docs/03 section 6.4 calls a `
        + 'cohort under 20 too small for z-scores to mean much — these ratings are noisy.');
    }

    const z = cohortZ(cohort, metrics);
    const spec = BLENDS[role];

    // Sub-stats first, then OVR from them, because docs/03 section 6.3 defines OVR as a
    // weighted sum of the sub-stats rather than a separate blend of the raw metrics.
    cohort.forEach((a, i) => {
      a.sub = Object.fromEntries(SUB_KEYS.map((k) => [k, statFromZ(blend(spec[k], z, i))]));
      const rawOvr = sum(SUB_KEYS.map((k) => a.sub[k] * OVR_WEIGHTS[role][k]));
      const bonus = Math.min(
        ACCOLADE_CAP,
        sum([...a.accolades].map((acc) => ACCOLADE_BONUS[acc] || 0)),
      );
      a.regionAdj = regionAdjustment(strength, a.region);
      a.rawOvr = rawOvr + bonus + a.regionAdj;
      a.bonus = bonus;
    });

    for (const a of cohort) {
      rated.push({ a, role, cohortSize: cohort.length, realNames, metrics });
    }
    yearCards += cohort.length;
  }

  console.log(`${bundle.year}: ${byPlayer.size} player-seasons -> ${yearCards} cards `
    + `(${thinGames} under ${MIN_GAMES} weighted games, ${partlySeen} without a domestic `
    + `season in this pull, ${roleSplit} role-ambiguous)`);
}

// --- 5. map onto the band shares, then mint -----------------------------------

/**
 * One ranking over the whole catalogue, not one per cohort.
 *
 * `rawOvr` is already cohort-relative — it is built from z-scores taken inside a (role,
 * season) cohort — so ranking those scores against each other compares like with like, and
 * the "target 40-99 distribution" docs/03 section 6.3 maps onto is the catalogue-wide one
 * from docs/02 section 3.
 *
 * Mapping inside each cohort instead, as this did at first, quietly breaks the top of the
 * scale: the ICON band is 1.5% of the range, which in a 60-player cohort is narrower than a
 * single rank step, so only the first-ranked player could ever reach it. The result was a
 * pile of cards at exactly 99, nothing at all between 92 and 98, and a cliff down to 91.
 */
const rankedAll = percentiles(rated.map((r) => r.a.rawOvr));
rated.forEach((r, i) => { r.a.percentile = rankedAll[i]; });

{
  for (const { a, role, cohortSize, realNames, metrics } of rated) {
      const ovr = ovrFromPercentile(a.percentile);
      const accolades = [...a.accolades].sort();
      const pool = championPool(a);
      const identity = realNames.get(a.link) || {};
      const events = [...a.events.entries()].sort((x, y) => y[1] - x[1]).map(([k]) => k);
      const m = metrics.get(a.link);

      // Display name is the player's handle; the card key uses the wiki page name, which is
      // what disambiguates two players who have shared a handle over the years.
      const displayName = identity.handle || a.link.replace(/\s*\(.*\)$/, '');

      cards.push({
        cardKey: `${slug(a.link)}-${a.year}`,
        kind: 'PLAYER',
        playerName: displayName,
        realName: identity.name || null,
        season: a.year,
        team: modal(a.teams) || 'Unknown',
        region: modal(a.regions) || null,
        role,
        ovr,
        rarity: rarityForOvr(ovr, accolades),
        accolades,
        subStats: a.sub,
        championPool: pool,
        // The card back, per docs/09 section 5. GD@15 is absent rather than guessed: the
        // source has no lane stats at 15 minutes, and a made-up number on the box score
        // would undo the point of the provenance line sitting right below it.
        // A line the source could not supply is left off the box score rather than printed
        // as a zero, which is the same rule the ratings follow.
        seasonSummary: {
          Games: a.games,
          'K/D/A': [a.totals.k, a.totals.d, a.totals.a]
            .map((v) => (v / a.games).toFixed(1)).join(' / '),
          KDA: ((a.totals.k + a.totals.a) / Math.max(1, a.totals.d)).toFixed(1),
          'Win%': `${Math.round((a.wins / a.games) * 100)}%`,
          ...(m.dpm != null ? { DPM: Math.round(m.dpm) } : {}),
          ...(m.kp != null ? { 'KP%': `${Math.round(m.kp * 100)}%` } : {}),
          ...(m.vspm != null ? { 'VS/min': m.vspm.toFixed(2) } : {}),
        },
        artChampionKey: pool[0]?.championKey || null,
        artFocus: '50% 32%',
        provenance: {
          source: 'LEAGUEPEDIA',
          note: `Derived from ${a.games} games (${events.slice(0, 3).join(', ')})`
            + ` — Leaguepedia. Catalogue ${SEMVER || '{semver}'}.`
            + ' Laning and vision are proxies: the scoreboard carries no lane stats at 15'
            + ' minutes and no ward counts.',
          pipeline: PIPELINE,
          games: a.games,
          weightedGames: Number(a.weighted.toFixed(1)),
          events,
          tiers: Object.fromEntries(a.tiers),
          cohort: `${role} ${a.year} (n=${cohortSize})`,
          accoladeBonus: a.bonus,
          leagueStrengthAdj: Number(a.regionAdj.toFixed(1)),
          // Columns the source never reported for this player-season. Anything listed here
          // scored neutral rather than measured, and the sub-stats built on it are weaker.
          ...(a.incomplete.length ? { unreported: a.incomplete } : {}),
          proxies: {
            laning: role === 'SUP'
              ? 'kill participation and deaths — no lane stats at 15 minutes'
              : 'CS and gold per minute — no gold/XP/CS difference at 15 minutes',
            vision: 'vision score per minute only — no wards placed or destroyed',
            ...(role === 'SUP' ? { teamfight: 'no damage taken column; its weight is redistributed' } : {}),
          },
        },
      });
  }
}

// --- 6. collapse duplicates and sort ------------------------------------------

const byKey = new Map();
let collapsed = 0;
for (const c of cards) {
  const existing = byKey.get(c.cardKey);
  if (existing) {
    collapsed++;
    if (c.provenance.games > existing.provenance.games) byKey.set(c.cardKey, c);
    continue;
  }
  byKey.set(c.cardKey, c);
}
const final = [...byKey.values()].sort((a, b) => b.ovr - a.ovr || a.cardKey.localeCompare(b.cardKey));
if (collapsed) console.log(`\n${collapsed} duplicate card keys collapsed`);

const years = [...new Set(coveredYears)].sort();
const semver = SEMVER
  || `${years[0]}-${years[years.length - 1]}.${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
for (const c of final) c.provenance.note = c.provenance.note.replace('{semver}', semver);

// --- 6. validation gate (docs/03 section 6.4) ---------------------------------

const bands = {};
const roles = {};
const bySeason = {};
for (const c of final) {
  bands[c.rarity] = (bands[c.rarity] || 0) + 1;
  roles[c.role] = (roles[c.role] || 0) + 1;
  bySeason[c.season] = (bySeason[c.season] || 0) + 1;
}

let fatal = 0;
const fail = (msg) => { fatal++; console.error(`x ${msg}`); };

for (const c of final) {
  if (!Number.isInteger(c.ovr) || c.ovr < 40 || c.ovr > 99) fail(`${c.cardKey}: ovr ${c.ovr} outside 40-99`);
  if (!ROLES.includes(c.role)) fail(`${c.cardKey}: role ${c.role} is not one of the five`);
  if (c.rarity !== rarityForOvr(c.ovr, c.accolades)) fail(`${c.cardKey}: rarity ${c.rarity} does not follow from ovr ${c.ovr}`);
  for (const [k, v] of Object.entries(c.subStats)) {
    if (!Number.isInteger(v) || v < 1 || v > 99) fail(`${c.cardKey}: ${k} ${v} outside 1-99`);
  }
  for (const p of c.championPool) {
    if (p.mastery < 0 || p.mastery > 100) fail(`${c.cardKey}: mastery ${p.mastery} on ${p.championName} outside 0-100`);
  }
}

// Clamping instead of mapping shows up as a pile-up at the ends of the scale.
const atEdge = final.filter((c) => c.ovr === 40 || c.ovr === 99).length;
if (atEdge / final.length > 0.025) {
  warn(`${((atEdge / final.length) * 100).toFixed(1)}% of cards sit at an OVR boundary — `
    + 'docs/03 section 6.4 calls over 2.5% a sign of clamping rather than mapping.');
}

/**
 * A smoke test for the whole chain that nobody had to hand-author an opinion for: if the
 * ratings are wired up correctly, the players who won Worlds should sit near the top of
 * their own cohort. If they do not, something upstream is wrong, and an editorial anchor
 * list would only have hidden it behind a number someone chose.
 */
const champions = final.filter((c) => c.accolades.includes('WORLDS_WINNER'));
const lowChampions = champions.filter((c) => c.ovr < 77);
if (champions.length && lowChampions.length / champions.length > 0.2) {
  warn(`${lowChampions.length} of ${champions.length} Worlds winners rate below EPIC `
    + `(${lowChampions.slice(0, 5).map((c) => `${c.cardKey} ${c.ovr}`).join(', ')}) — `
    + 'the chain from metrics to OVR is suspect.');
}

if (fatal) {
  console.error(`\n${fatal} rows violate the schema in supabase/migrations/0001_init.sql — nothing written.`);
  process.exit(1);
}
if (STRICT && warnings.length) {
  console.error(`\n--strict: ${warnings.length} warnings, nothing written.`);
  process.exit(1);
}

// --- 7. write ------------------------------------------------------------------

const catalogue = {
  semver,
  builtAt: new Date().toISOString(),
  source: 'LEAGUEPEDIA',
  notes: `Official Primary tournaments ${years[0]}-${years[years.length - 1]}, at least `
    + `${MIN_GAMES} tier-weighted games with ${Math.round(MIN_ROLE_SHARE * 100)}% in one role. `
    + 'Sub-stats are z-scores inside a (role, season) cohort; OVR is their role-weighted sum '
    + 'plus an accolade bonus, percentile-mapped onto the docs/02 band shares. Laning and '
    + 'vision are proxies — Leaguepedia carries no lane stats at 15 minutes and no ward counts.',
  pipeline: PIPELINE,
  sourceHashes,
  counts: { cards: final.length, bands, roles, bySeason },
  cards: final,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(catalogue, null, 2)}\n`, 'utf8');

console.log(`\nwrote ${OUT} — ${final.length} cards, catalogue ${semver}`);
console.log(`  roles  ${ROLES.map((r) => `${r} ${roles[r] || 0}`).join('  ')}`);
console.log('\n  band        cards   share   target');
const TARGETS = { COMMON: 0.45, RARE: 0.30, EPIC: 0.17, LEGENDARY: 0.065, ICON: 0.015 };
for (const band of ['COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'ICON']) {
  const n = bands[band] || 0;
  const share = n / final.length;
  console.log(`  ${band.padEnd(11)} ${String(n).padStart(5)}  ${(share * 100).toFixed(1).padStart(5)}%  ${(TARGETS[band] * 100).toFixed(1).padStart(5)}%`);
  if (!n) warn(`no ${band} cards — packs will fall back to the next band down`);
}
console.log('\nPush it with:  npm run catalogue:push');
