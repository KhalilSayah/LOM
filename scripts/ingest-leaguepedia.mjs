/**
 * Stage 1 of docs/03-data-pipeline.md: pull raw professional match data from Leaguepedia
 * and write it to disk. Nothing is rated here.
 *
 *   node scripts/ingest-leaguepedia.mjs --years 2020..2026
 *   node scripts/ingest-leaguepedia.mjs --years 2024 --leagues LCK,LEC --force
 *   node scripts/ingest-leaguepedia.mjs --years 2015..2026 --all-leagues
 *
 * Output is one bundle per year at .data/raw/leaguepedia-{year}.json, holding the
 * tournaments, every scoreboard row, every game header and the final placements, exactly as
 * the API returned them. scripts/build-catalogue.mjs reads those bundles and never touches
 * the network, so the rating formula can be rewritten and re-run in seconds against data
 * that was fetched once.
 *
 * That split is the point of this file. The previous version fetched and rated in one pass,
 * which meant every change to a sub-stat weight risked another walk down the scrape path.
 *
 * Politeness, because this is someone else's server and it is free:
 *   - One request at a time, at most one per LOM_THROTTLE_MS (default 1100ms).
 *   - A User-Agent that names the project.
 *   - Every response cached to .data/leaguepedia/ keyed by the query, so a re-run after a
 *     failure re-fetches only what it never got. The cache key includes a hash of the query
 *     itself, so changing the requested fields correctly invalidates it instead of quietly
 *     replaying a response that lacks the new columns.
 *   - Leaguepedia signals rate limiting in the response body rather than the status, so the
 *     backoff reads both. The only correct answer to it is to wait longer.
 *
 * Why Leaguepedia and not Oracle's Elixir, which docs/03 section 1 prefers: the OE downloads
 * sit behind a Google Drive folder rendered client-side, and docs/03 section 11.1 requires
 * the maintainer's written permission before this project leans on them. Until someone has
 * that in writing, this is the fallback that same section names. The cost is real and is
 * recorded per card by the build stage: no gold/XP/CS difference at 15 minutes, no ward
 * counts, no damage taken.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const HTTP_CACHE = join(root, '.data/leaguepedia');
const RAW_DIR = join(root, '.data/raw');

const API = 'https://lol.fandom.com/api.php';
const UA = 'lom-catalogue-builder/0.2 (League of Managers; private, non-commercial)';
const PAGE = 500;
// Leaguepedia starts refusing at roughly one request a second, and each refusal costs a
// 15-45s penalty, so pacing slower than the limit finishes a long run sooner than racing it.
const THROTTLE_MS = Number(process.env.LOM_THROTTLE_MS || 2100);

// --- CLI ---------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const YEARS = parseYears(flag('years', String(new Date().getUTCFullYear())));
const LEAGUES = flag('leagues', 'LCK,LPL,LEC,LCS,LTA,LCKC,LFL')
  .split(',').map((s) => s.trim()).filter(Boolean);
const ALL_LEAGUES = has('all-leagues');
const FORCE = has('force');

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
let fetched = 0;
let served = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Cache filename for a query. The readable prefix is there so the cache directory can be
 * browsed by eye; the hash is what actually makes it correct, because two queries differing
 * only in their field list must not share a file.
 */
function cacheFile(label, params) {
  const hash = createHash('sha1').update(JSON.stringify(params)).digest('hex').slice(0, 10);
  const safe = label.replace(/[^a-z0-9_.-]/gi, '_').slice(0, 90);
  return join(HTTP_CACHE, `${safe}.${hash}.json`);
}

async function cargo(params, label) {
  const file = cacheFile(label, params);
  if (existsSync(file)) {
    served++;
    return JSON.parse(readFileSync(file, 'utf8'));
  }

  const wait = THROTTLE_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);

  const url = new URL(API);
  url.searchParams.set('action', 'cargoquery');
  url.searchParams.set('format', 'json');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  let body;
  for (let attempt = 0; ; attempt++) {
    lastCall = Date.now();

    // A dropped socket partway through a multi-hour job is ordinary, and it arrives as a
    // thrown TypeError rather than a status, so it needs catching separately or one blip
    // ends the run.
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(45000) });
    } catch (err) {
      if (attempt >= 5) throw new Error(`cargo: ${err instanceof Error ? err.message : String(err)}`);
      const backoff = 5000 * (attempt + 1);
      process.stdout.write(`\n  network error, waiting ${backoff / 1000}s... `);
      await sleep(backoff);
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 5) throw new Error(`cargo: HTTP ${res.status} after ${attempt + 1} attempts`);
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 8000 * (attempt + 1));
      continue;
    }

    body = await res.json();
    if (!body.error) break;

    const info = body.error.info || body.error.code || 'unknown';
    const throttled = /rate limit/i.test(info);
    if (attempt >= (throttled ? 5 : 3)) throw new Error(`cargo: ${info}`);
    const backoff = throttled ? 15000 * (attempt + 1) : 1500 * (attempt + 1);
    process.stdout.write(`\n  ${throttled ? 'rate limited' : 'error'}, waiting ${Math.round(backoff / 1000)}s... `);
    await sleep(backoff);
  }

  const rows = (body?.cargoquery || []).map((r) => r.title);
  mkdirSync(HTTP_CACHE, { recursive: true });
  writeFileSync(file, JSON.stringify(rows), 'utf8');
  fetched++;
  return rows;
}

/** Page through a Cargo table until a short page comes back. */
async function cargoAll(params, label) {
  const all = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await cargo({ ...params, limit: PAGE, offset }, `${label}_${offset}`);
    all.push(...page);
    if (page.length < PAGE) break;
  }
  return all;
}

const quote = (s) => String(s).replace(/'/g, "\\'");

// --- what counts as which kind of event --------------------------------------

/**
 * Read this off the page title, not the League field. Leaguepedia files the regional
 * qualifier gauntlets ("LPL/2024 Season/Regional Finals") under League = "World
 * Championship", so trusting the league would hand a domestic qualifier the 1.35
 * international weight and call its winner a Worlds finalist.
 */
const isInternational = (t) =>
  /World Championship|Mid-Season Invitational|MSI|First Stand/i.test(t.OverviewPage || '');

/**
 * Play-in and qualifier brackets are separate tournament pages with their own first place,
 * and winning a Worlds play-in is not winning Worlds. Flagged here so the build stage can
 * refuse to hand out a title for one without re-deriving the rule.
 */
const isSideBracket = (t) =>
  /Play-?In|Qualifier|Promotion|Regional Finals|Kickoff|Showmatch/i.test(t.OverviewPage || '');

// --- the four tables ---------------------------------------------------------

async function tournaments(year) {
  const rows = await cargoAll({
    tables: 'Tournaments=T',
    fields: 'T.OverviewPage,T.League,T.Year,T.Region,T.TournamentLevel,T.DateStart,T.IsPlayoffs,T.Split',
    where: `T.Year=${year} AND T.IsOfficial='1' AND T.TournamentLevel='Primary'`,
    order_by: 'T.DateStart',
  }, `tournaments_${year}`);

  return rows.filter((t) => {
    if (ALL_LEAGUES) return true;
    if (isInternational(t)) return true;
    // `League` is the long name ("LoL Champions Korea") and is sometimes empty, while the
    // page title carries the short code ("LCK/2024 Season/Spring Season"). Match both, and
    // match on a word boundary so LCK does not also pull in LCKC.
    const hay = `${t.OverviewPage || ''} ${t.League || ''}`.toUpperCase();
    return LEAGUES.some((l) => new RegExp(`\\b${l.toUpperCase()}\\b`).test(hay));
  });
}

/**
 * Scoreboard rows. TeamKills and TeamGold come back on the player row itself, which is what
 * makes a real kill-participation figure possible without a second query.
 */
const scoreboardPlayers = (t) => cargoAll({
  tables: 'ScoreboardPlayers=SP',
  fields: 'SP.Link,SP.Champion,SP.Kills,SP.Deaths,SP.Assists,SP.Gold,SP.CS,'
    + 'SP.DamageToChampions,SP.VisionScore,SP.PlayerWin,SP.Role,SP.Team,SP.Side,'
    + 'SP.TeamKills,SP.TeamGold,SP.GameId',
  where: `SP.OverviewPage='${quote(t.OverviewPage)}'`,
}, `sbp_${t.OverviewPage}`);

/**
 * Game headers, for the one column the scoreboard lacks and everything downstream needs:
 * duration. Without it every rate stat is per game, so a slow team's laner reads as better
 * than they were. Team objective counts come along for free and give `macro` a real input.
 */
const scoreboardGames = (t) => cargoAll({
  tables: 'ScoreboardGames=SG',
  // Gamelength_Number is aliased because Cargo returns an underscored field under its
  // display name, with a space ("Gamelength Number"). Reading it by the name it was asked
  // for would silently yield undefined, and every rate stat downstream would be zero.
  fields: 'SG.GameId,SG.Gamelength_Number=LengthMin,SG.Team1,SG.Team2,SG.Team1Kills,SG.Team2Kills,'
    + 'SG.Team1Towers,SG.Team2Towers,SG.Team1Barons,SG.Team2Barons,SG.Team1Dragons,'
    + 'SG.Team2Dragons,SG.WinTeam,SG.Patch',
  where: `SG.OverviewPage='${quote(t.OverviewPage)}'`,
}, `sbg_${t.OverviewPage}`);

const resultsFor = (page) => cargo({
  tables: 'TournamentResults=TR',
  fields: 'TR.Place,TR.Team',
  where: `TR.OverviewPage='${quote(page)}'`,
  limit: 50,
}, `res_${page}`);

/**
 * Final placements.
 *
 * Worlds is split across sub-pages — the Tournaments table lists "2024 Season World
 * Championship/Main Event" as the Primary tournament — but TournamentResults files the
 * placements on the parent event page, "2024 Season World Championship". Querying only the
 * page named by Tournaments returns nothing for Worlds, so no player in the catalogue ever
 * received WORLDS_WINNER. MSI has no sub-page and so never showed the problem.
 *
 * The fallback is restricted to international events. A domestic sub-page that happens to
 * have no results would otherwise inherit its season's standings and hand out a title for
 * finishing top of a regular split.
 */
async function placements(t) {
  const rows = await resultsFor(t.OverviewPage);
  if (rows.length || !isInternational(t) || !t.OverviewPage.includes('/')) return rows;
  return resultsFor(t.OverviewPage.slice(0, t.OverviewPage.lastIndexOf('/')));
}

/**
 * Real names, for the card's identity line. Queried in batches of page names rather than one
 * request per player, which turns a few thousand requests into a few dozen.
 *
 * Portraits are deliberately not pulled. docs/03 section 8.2 defaults them to a generated
 * avatar until a specific file's licence has been recorded, and a photograph of a real
 * person is not covered by the wiki's text licence.
 */
async function players(links) {
  const out = [];
  const batch = 80;
  for (let i = 0; i < links.length; i += batch) {
    const slice = links.slice(i, i + batch);
    const rows = await cargo({
      tables: 'Players=P',
      fields: 'P.OverviewPage,P.ID,P.Name,P.Country',
      where: slice.map((l) => `P.OverviewPage='${quote(l)}'`).join(' OR '),
      limit: batch,
    }, `players_${createHash('sha1').update(slice.join('|')).digest('hex').slice(0, 12)}`);
    out.push(...rows);
    process.stdout.write(`\r  players ${Math.min(i + batch, links.length)}/${links.length}   `);
  }
  process.stdout.write('\n');
  return out;
}

// --- one year ----------------------------------------------------------------

async function ingestYear(year) {
  const outFile = join(RAW_DIR, `leaguepedia-${year}.json`);
  if (existsSync(outFile) && !FORCE) {
    console.log(`${year}: bundle already written, skipping (--force to refetch)`);
    return;
  }

  const events = await tournaments(year);
  console.log(`${year}: ${events.length} tournaments`);
  if (!events.length) {
    console.log(`  nothing official and Primary matched — widen --leagues or use --all-leagues`);
    return;
  }

  const bundle = {
    year,
    pulledAt: new Date().toISOString(),
    source: 'LEAGUEPEDIA',
    tournaments: [],
    rows: [],
    games: [],
    results: {},
  };

  for (const [i, t] of events.entries()) {
    process.stdout.write(`\r  ${i + 1}/${events.length} ${t.OverviewPage.slice(0, 56).padEnd(56)}`);

    const rows = await scoreboardPlayers(t);
    if (!rows.length) continue;
    const games = await scoreboardGames(t);
    const places = await placements(t);

    bundle.tournaments.push({
      page: t.OverviewPage,
      league: t.League || null,
      region: t.Region || null,
      split: t.Split || null,
      dateStart: t.DateStart || null,
      isPlayoffs: t.IsPlayoffs === '1',
      isInternational: isInternational(t),
      isSideBracket: isSideBracket(t),
    });

    // The tournament page is carried on every row so the build stage can weight a game by
    // the event it was played at without re-joining anything.
    for (const r of rows) bundle.rows.push({ ...r, Page: t.OverviewPage });
    for (const g of games) bundle.games.push({ ...g, Page: t.OverviewPage });
    bundle.results[t.OverviewPage] = places;
  }
  process.stdout.write('\n');

  const links = [...new Set(bundle.rows.map((r) => r.Link).filter(Boolean))].sort();
  bundle.players = await players(links);

  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(outFile, JSON.stringify(bundle), 'utf8');

  const mb = (JSON.stringify(bundle).length / 1e6).toFixed(1);
  console.log(`  wrote .data/raw/leaguepedia-${year}.json — ${bundle.rows.length} scoreboard rows, `
    + `${bundle.games.length} games, ${links.length} players (${mb} MB)`);
}

// --- main --------------------------------------------------------------------

console.log(`years   ${YEARS.join(', ')}`);
console.log(`leagues ${ALL_LEAGUES ? 'all official Primary tournaments' : LEAGUES.join(', ')} (+ Worlds, MSI, First Stand)`);
console.log(`cache   ${HTTP_CACHE}`);
console.log(`out     ${RAW_DIR}\n`);

for (const year of YEARS) {
  await ingestYear(year);
}

console.log(`\n${fetched} requests made, ${served} served from cache.`);
console.log('Derive a catalogue from these bundles with:  npm run catalogue:build');
