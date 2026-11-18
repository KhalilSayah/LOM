/**
 * Build a real catalogue from Leaguepedia, per docs/03-data-pipeline.md.
 *
 *   node scripts/ingest-leaguepedia.mjs --years 2024,2025
 *   node scripts/ingest-leaguepedia.mjs --years 2023 --leagues LCK,LEC,LCS,LPL
 *   node scripts/ingest-leaguepedia.mjs --years 2015..2025 --all-leagues --min-games 12
 *
 * What it does
 *   1. Lists official Primary tournaments for the requested years (Tournaments table).
 *   2. Pulls every scoreboard row for them (ScoreboardPlayers), paged and cached on disk.
 *   3. Aggregates per player-season: games, win rate, K/D/A, gold, CS, damage, vision, and
 *      the champion pool with per-champion games and win rate.
 *   4. Normalises each metric to a percentile *within the player's role*, blends them into
 *      one score, and maps that percentile onto the OVR bands in docs/02 section 3, so the
 *      catalogue shares come out right by construction rather than by hand-tuning.
 *   5. Derives accolades from TournamentResults (first and second place at Worlds/MSI,
 *      first place domestically) and lets rarityForOvr decide the band.
 *   6. Writes data/catalogue.json in the same shape scripts/build-catalogue.mjs produces,
 *      so scripts/push-catalogue.mjs does not care which one built it.
 *
 * Honest limits, because they change what the numbers mean:
 *   - ScoreboardPlayers has no game duration, so "per minute" stats are per *game*. Across
 *     a season that mostly washes out, but a slow-game team's laner looks better than they
 *     are. docs/03 wants Oracle's Elixir for exactly this reason; this is the free path.
 *   - Macro has no clean proxy here. It is blended from win rate and kill participation,
 *     which is the weakest of the six and is marked as such in the provenance.
 *   - Role comes from the scoreboard row, so a player who swapped roles mid-season is
 *     attributed to the role they played most.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rarityForOvr } from '../packages/card-engine/src/rarity.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const CACHE = join(root, '.data/leaguepedia');

const API = 'https://lol.fandom.com/api.php';
const UA = 'lom-catalogue-builder/0.1 (League of Managers; private, non-commercial)';
const PAGE = 500;
const THROTTLE_MS = Number(process.env.LOM_THROTTLE_MS || 1100);

// --- CLI ---------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const YEARS = parseYears(flag('years', String(new Date().getUTCFullYear())));
const LEAGUES = flag('leagues', 'LCK,LPL,LEC,LCS')
  .split(',').map((s) => s.trim()).filter(Boolean);
const ALL_LEAGUES = has('all-leagues');
const MIN_GAMES = Number(flag('min-games', '15'));
const OUT = flag('out', 'data/catalogue.json');

function parseYears(spec) {
  const out = new Set();
  for (const part of spec.split(',')) {
    const range = part.match(/^(\d{4})\.\.(\d{4})$/);
    if (range) {
      for (let y = Number(range[1]); y <= Number(range[2]); y++) out.add(y);
    } else if (/^\d{4}$/.test(part.trim())) {
      out.add(Number(part.trim()));
    }
  }
  return [...out].sort();
}

// --- Cargo client ------------------------------------------------------------

let lastCall = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cargo(params, cacheKey) {
  const file = cacheKey ? join(CACHE, `${cacheKey.replace(/[^a-z0-9_.-]/gi, '_')}.json`) : null;
  if (file && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));

  const wait = THROTTLE_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);

  const url = new URL(API);
  url.searchParams.set('action', 'cargoquery');
  url.searchParams.set('format', 'json');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  // Leaguepedia rate-limits by body message rather than by status, and it means it. The
  // only correct response is to wait longer, not to retry harder or spoof a User-Agent.
  let body;
  for (let attempt = 0; ; attempt++) {
    lastCall = Date.now();
    const res = await fetch(url, { headers: { 'User-Agent': UA } });

    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 5) throw new Error(`cargo: HTTP ${res.status} after ${attempt + 1} attempts`);
      await sleep(8000 * (attempt + 1));
      continue;
    }

    body = await res.json();
    if (!body.error) break;

    const info = body.error.info || body.error.code || 'unknown';
    const throttled = /rate limit/i.test(info);
    if (attempt >= (throttled ? 5 : 3)) throw new Error(`cargo: ${info}`);
    const backoff = throttled ? 15000 * (attempt + 1) : 1500 * (attempt + 1);
    process.stdout.write(`
  ${throttled ? 'rate limited' : 'error'}, waiting ${Math.round(backoff / 1000)}s... `);
    await sleep(backoff);
  }
  const rows = (body?.cargoquery || []).map((r) => r.title);
  if (file) {
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(file, JSON.stringify(rows), 'utf8');
  }
  return rows;
}

/** Page through a Cargo table until a short page comes back. */
async function cargoAll(params, cacheKey) {
  const all = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await cargo({ ...params, limit: PAGE, offset }, `${cacheKey}_${offset}`);
    all.push(...page);
    if (page.length < PAGE) break;
  }
  return all;
}

// --- 1. tournaments ----------------------------------------------------------

async function tournaments(year) {
  const rows = await cargoAll({
    tables: 'Tournaments=T',
    fields: 'T.OverviewPage,T.League,T.Year,T.Region,T.TournamentLevel,T.DateStart',
    where: `T.Year=${year} AND T.IsOfficial='1' AND T.TournamentLevel='Primary'`,
    order_by: 'T.DateStart',
  }, `tournaments_${year}`);

  return rows.filter((t) => {
    if (ALL_LEAGUES) return true;
    if (isInternational(t)) return true;
    // `League` is the long name ("LoL Champions Korea") and is sometimes empty, while the
    // page title carries the short code ("LCK/2024 Season/Spring Season"). Match both.
    const hay = `${t.OverviewPage || ''} ${t.League || ''}`.toUpperCase();
    return LEAGUES.some((l) => hay.includes(l.toUpperCase()));
  });
}

const isInternational = (t) =>
  /World Championship|Mid-Season Invitational|MSI/i.test(`${t.OverviewPage || ''} ${t.League || ''}`);

/**
 * Which accolade a placement at this tournament is worth.
 *
 * Qualifying and play-in stages are their own tournament pages with their own first place,
 * and winning a Worlds play-in bracket is not winning Worlds. Without this check the
 * catalogue hands WORLDS_WINNER to whoever topped the play-in, which is both wrong and
 * exactly the kind of error nobody notices until a card says it on the front.
 */
function accoladeFor(tournament, place) {
  const page = tournament.OverviewPage || '';
  if (/Play-?In|Qualifier|Promotion|Regional Finals|Kickoff|Showmatch/i.test(page)) return null;

  if (isInternational(tournament)) {
    // MSI is an international title, not a world title. Conflating them puts WORLDS_WINNER
    // on the front of a card whose team did not win Worlds that year.
    const isWorlds = /World Championship/i.test(`${page} ${tournament.League || ''}`);
    if (place === 1) return isWorlds ? ['WORLDS_WINNER', 'INTERNATIONAL_FINALIST'] : ['INTERNATIONAL_FINALIST'];
    if (place === 2) return ['INTERNATIONAL_FINALIST'];
    return null;
  }
  // A domestic title means the split, not the regular season it was seeded from.
  if (place === 1 && /Playoffs|Season Finals|Finals/i.test(page)) return ['DOMESTIC_TITLE'];
  return null;
}

// --- 2. scoreboard rows ------------------------------------------------------

async function scoreboard(tournament) {
  return cargoAll({
    tables: 'ScoreboardPlayers=SP',
    fields: 'SP.Link,SP.Champion,SP.Kills,SP.Deaths,SP.Assists,SP.Gold,SP.CS,'
      + 'SP.DamageToChampions,SP.VisionScore,SP.PlayerWin,SP.Role,SP.Team,SP.GameId',
    where: `SP.OverviewPage='${tournament.OverviewPage.replace(/'/g, "\\'")}'`,
  }, `sb_${tournament.OverviewPage}`);
}

// --- 3. accolades ------------------------------------------------------------

async function placements(tournament) {
  const rows = await cargo({
    tables: 'TournamentResults=TR',
    fields: 'TR.Place,TR.Team',
    where: `TR.OverviewPage='${tournament.OverviewPage.replace(/'/g, "\\'")}'`,
    limit: 50,
  }, `res_${tournament.OverviewPage}`);
  const first = rows.filter((r) => r.Place === '1').map((r) => r.Team);
  const second = rows.filter((r) => r.Place === '2').map((r) => r.Team);
  return { first, second };
}

// --- aggregation -------------------------------------------------------------

const ROLE_MAP = { Top: 'TOP', Jungle: 'JNG', Mid: 'MID', Bot: 'BOT', Support: 'SUP' };
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const champKey = (name) => String(name || '').replace(/[^A-Za-z0-9]/g, '');

function blankAgg(player, year) {
  return {
    player, year,
    games: 0, wins: 0,
    kills: 0, deaths: 0, assists: 0,
    gold: 0, cs: 0, damage: 0, vision: 0,
    kdaPerGame: [],
    roles: new Map(), teams: new Map(), regions: new Map(),
    champs: new Map(),
    accolades: new Set(),
    tournaments: new Set(),
  };
}

const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
const modal = (map) => [...map.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

// --- normalisation -----------------------------------------------------------

/** Percentile of each value within its own array, 0..1. */
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

/** docs/02 section 3 band shares, applied as a piecewise map from percentile to OVR. */
function ovrFromPercentile(p) {
  const bands = [
    [0.450, 40, 67],
    [0.300, 68, 76],
    [0.170, 77, 84],
    [0.065, 85, 91],
    [0.015, 92, 99],
  ];
  let acc = 0;
  for (const [share, lo, hi] of bands) {
    if (p <= acc + share || share === 0.015) {
      const within = share === 0 ? 0 : (p - acc) / share;
      return Math.round(lo + Math.max(0, Math.min(1, within)) * (hi - lo));
    }
    acc += share;
  }
  return 40;
}

const scale = (p, lo = 40, hi = 99) => Math.round(lo + Math.max(0, Math.min(1, p)) * (hi - lo));
const stdev = (xs) => {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};

// --- main --------------------------------------------------------------------

async function main() {
  console.log(`years   ${YEARS.join(', ')}`);
  console.log(`leagues ${ALL_LEAGUES ? 'all official Primary tournaments' : LEAGUES.join(', ')} (+ Worlds, MSI)`);
  console.log(`cache   ${CACHE}\n`);

  /** @type {Map<string, ReturnType<typeof blankAgg>>} */
  const agg = new Map();

  for (const year of YEARS) {
    const events = await tournaments(year);
    console.log(`${year}: ${events.length} tournaments`);

    for (const [i, t] of events.entries()) {
      const rows = await scoreboard(t);
      if (!rows.length) continue;

      const { first, second } = await placements(t);

      for (const r of rows) {
        const player = r.Link;
        if (!player) continue;
        const key = `${player}__${year}`;
        if (!agg.has(key)) agg.set(key, blankAgg(player, year));
        const a = agg.get(key);

        const k = num(r.Kills);
        const d = num(r.Deaths);
        const as = num(r.Assists);

        a.games += 1;
        a.wins += r.PlayerWin === 'Yes' ? 1 : 0;
        a.kills += k; a.deaths += d; a.assists += as;
        a.gold += num(r.Gold);
        a.cs += num(r.CS);
        a.damage += num(r.DamageToChampions);
        a.vision += num(r.VisionScore);
        a.kdaPerGame.push((k + as) / Math.max(1, d));

        if (ROLE_MAP[r.Role]) bump(a.roles, ROLE_MAP[r.Role]);
        if (r.Team) bump(a.teams, r.Team);
        if (t.Region) bump(a.regions, t.Region);
        a.tournaments.add(t.League || t.OverviewPage);

        if (r.Champion) {
          const c = a.champs.get(r.Champion) || { games: 0, wins: 0 };
          c.games += 1;
          c.wins += r.PlayerWin === 'Yes' ? 1 : 0;
          a.champs.set(r.Champion, c);
        }

        if (r.Team && first.includes(r.Team)) {
          for (const acc of accoladeFor(t, 1) || []) a.accolades.add(acc);
        }
        if (r.Team && second.includes(r.Team)) {
          for (const acc of accoladeFor(t, 2) || []) a.accolades.add(acc);
        }
      }

      process.stdout.write(`\r  ${i + 1}/${events.length} ${t.OverviewPage.slice(0, 58).padEnd(58)}`);
    }
    process.stdout.write('\n');
  }

  // Worlds is its own league name; a domestic title at an international event is nonsense.
  const seasons = [...agg.values()].filter((a) => a.games >= MIN_GAMES);
  console.log(`\n${agg.size} player-seasons, ${seasons.length} above ${MIN_GAMES} games`);
  if (!seasons.length) {
    console.error('nothing to write — widen --years or lower --min-games');
    process.exit(1);
  }

  // Per-role cohorts: a support is never compared to a bot laner.
  const byRole = new Map();
  for (const a of seasons) {
    a.role = modal(a.roles) || 'MID';
    if (!byRole.has(a.role)) byRole.set(a.role, []);
    byRole.get(a.role).push(a);
  }

  const cards = [];

  for (const [role, cohort] of byRole) {
    if (cohort.length < 40) {
      console.warn(`! ${role}: only ${cohort.length} seasons in the cohort — the band shares `
        + 'in docs/02 assume a full catalogue, so the top of this band will be compressed. '
        + 'Widen --years or --leagues before treating these ratings as final.');
    }
    const metric = (fn) => percentiles(cohort.map(fn));

    const pKda = metric((a) => (a.kills + a.assists) / Math.max(1, a.deaths));
    const pDmg = metric((a) => a.damage / a.games);
    const pCs = metric((a) => a.cs / a.games);
    const pGold = metric((a) => a.gold / a.games);
    const pVision = metric((a) => a.vision / a.games);
    const pWin = metric((a) => a.wins / a.games);
    const pKp = metric((a) => (a.kills + a.assists) / a.games);
    const pSteady = metric((a) => -stdev(a.kdaPerGame));
    const pGames = metric((a) => a.games);

    cohort.forEach((a, i) => {
      const sub = {
        laning: scale(0.6 * pCs[i] + 0.4 * pGold[i]),
        teamfight: scale(0.65 * pDmg[i] + 0.35 * pKp[i]),
        mechanics: scale(0.6 * pKda[i] + 0.4 * pDmg[i]),
        macro: scale(0.6 * pWin[i] + 0.4 * pKp[i]),
        vision: scale(pVision[i]),
        consistency: scale(0.7 * pSteady[i] + 0.3 * pGames[i]),
      };

      // One blended score, then the band map. Win rate is capped at a third of the weight:
      // a card is a player, not a team result.
      const score = 0.22 * pKda[i] + 0.20 * pDmg[i] + 0.16 * pCs[i]
        + 0.14 * pWin[i] + 0.12 * pVision[i] + 0.10 * pKp[i] + 0.06 * pSteady[i];
      a._score = score;
      a._sub = sub;
    });

    // Re-rank the blended score inside the cohort so the band shares hold per role.
    const ranked = percentiles(cohort.map((a) => a._score));
    cohort.forEach((a, i) => { a._p = ranked[i]; });

    for (const a of cohort) {
      const ovr = ovrFromPercentile(a._p);
      const accolades = [...a.accolades];
      const team = modal(a.teams) || 'Unknown';
      const region = modal(a.regions) || null;

      const pool = [...a.champs.entries()]
        .sort((x, y) => y[1].games - x[1].games)
        .slice(0, 8)
        .map(([name, c], slot) => ({
          championKey: champKey(name),
          championName: name,
          games: c.games,
          winrate: Number((c.wins / c.games).toFixed(3)),
          // Mastery is games on the champion against the player's own rating: a 92 OVR with
          // 30 games on one champion is a 95 there, the same player on a 4-game pick is not.
          mastery: Math.max(20, Math.min(100, Math.round(
            ovr * (0.72 + 0.28 * Math.min(1, c.games / 18)) + (c.wins / c.games - 0.5) * 8,
          ))),
          slot,
        }));

      cards.push({
        cardKey: `${slug(a.player)}-${a.year}`,
        kind: 'PLAYER',
        playerName: a.player,
        season: a.year,
        team,
        region,
        role: a.role,
        ovr,
        rarity: rarityForOvr(ovr, accolades),
        accolades,
        subStats: a._sub,
        championPool: pool,
        seasonSummary: {
          Games: a.games,
          KDA: ((a.kills + a.assists) / Math.max(1, a.deaths)).toFixed(1),
          'Win%': `${Math.round((a.wins / a.games) * 100)}%`,
          DPG: Math.round(a.damage / a.games),
        },
        artChampionKey: pool[0]?.championKey || null,
        artFocus: '50% 32%',
        provenance: {
          source: 'LEAGUEPEDIA',
          note: `Derived from ${a.games} games across ${[...a.tournaments].length} official `
            + `tournaments (${[...a.tournaments].slice(0, 3).join(', ')}). Ratings are `
            + `role-cohort percentiles; per-game rather than per-minute, since the source `
            + `table carries no game duration. Macro is the weakest proxy of the six.`,
          games: a.games,
          tournaments: [...a.tournaments],
        },
      });
    }
  }

  cards.sort((x, y) => y.ovr - x.ovr || x.cardKey.localeCompare(y.cardKey));

  const bands = {};
  const roles = {};
  for (const c of cards) {
    bands[c.rarity] = (bands[c.rarity] || 0) + 1;
    roles[c.role] = (roles[c.role] || 0) + 1;
  }

  const semver = process.env.CATALOGUE_SEMVER
    || `${YEARS[0]}-${YEARS[YEARS.length - 1]}.${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;

  const out = {
    semver,
    builtAt: new Date().toISOString(),
    source: 'LEAGUEPEDIA',
    notes: `Official Primary tournaments ${YEARS.join(', ')}; minimum ${MIN_GAMES} games. `
      + 'Ratings are role-cohort percentiles mapped onto the docs/02 band shares.',
    counts: { cards: cards.length, bands, roles },
    cards,
  };

  writeFileSync(join(root, OUT), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  console.log(`\nwrote ${OUT} — ${cards.length} cards, catalogue ${semver}`);
  console.log(`  bands  ${Object.entries(bands).map(([k, v]) => `${k} ${v}`).join('  ')}`);
  console.log(`  roles  ${Object.entries(roles).map(([k, v]) => `${k} ${v}`).join('  ')}`);
  console.log('\nPush it with:  node scripts/push-catalogue.mjs');
}

main().catch((err) => {
  console.error(`\n${err.stack || err.message}`);
  process.exit(1);
});
