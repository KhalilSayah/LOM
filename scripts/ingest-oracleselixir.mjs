/**
 * Stage 1 against Oracle's Elixir: read the yearly match-data CSVs and write the same kind
 * of raw bundle the Leaguepedia ingest writes, for scripts/build-catalogue.mjs to rate.
 *
 *   node scripts/ingest-oracleselixir.mjs
 *   node scripts/ingest-oracleselixir.mjs --dir .data/oe --years 2014..2019
 *
 * The CSVs are not fetched here. They are published once a day as a Google Drive folder
 * linked from oracleselixir.com/tools/downloads, and the page asks plainly that nobody pull
 * them more often than that, so downloading them is a deliberate manual step rather than
 * something a build script does on its own. Drop them in .data/oe/ and run this.
 *
 * Attribution is not optional. The data is "aggregated and released by Tim Sevenhuysen of
 * OraclesElixir.com ... provided free of charge, and intended for use by analysts,
 * commentators, and fans", which is what this project is. Every card built from it carries
 * that credit in its provenance, and docs/03 section 8.3 still governs what happens if this
 * ever stops being free to play.
 *
 * Why this source is worth the manual step: it carries the columns Leaguepedia does not.
 * Gold, XP and CS difference at 15 minutes, wards placed and killed, damage taken per
 * minute — the three sub-stats that were proxies become measurements, and seasons before
 * 2020 become rateable at all. Leaguepedia reports no damage and no vision whatsoever for
 * 2016 and 2017, so the classics cannot be derived from it in any form.
 *
 * This stage only parses and filters. Aggregation, titles and ratings all happen in the
 * build, which is why a bundle here is still one row per player per game.
 */

import { createReadStream, readdirSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const RAW_DIR = join(root, '.data/raw');

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const IN_DIR = join(root, flag('dir', '.data/oe'));
const YEARS = flag('years', null);

function wantedYear(y) {
  if (!YEARS) return true;
  const range = YEARS.match(/^(\d{4})\.\.(\d{4})$/);
  if (range) return y >= Number(range[1]) && y <= Number(range[2]);
  return YEARS.split(',').map((s) => s.trim()).includes(String(y));
}

/**
 * The columns the rating stage reads. Everything else in the file — bans, picks, item
 * builds, first-blood flags, per-drake-type counts — is left on disk.
 *
 * Checked by name on every file rather than trusted, because docs/03 section 3.1 warns that
 * the spellings drift between years. They do not drift in the files as published today: all
 * thirteen share one 165-column header, byte for byte. That is worth re-checking rather
 * than assuming, so a missing column aborts the run and says which one.
 */
const COLUMNS = [
  'gameid', 'datacompleteness', 'date', 'league', 'year', 'split', 'playoffs', 'game',
  'position', 'playername', 'playerid', 'teamname', 'champion',
  'gamelength', 'result', 'kills', 'deaths', 'assists', 'teamkills',
  'dpm', 'damageshare', 'damagetakenperminute',
  'wpm', 'wcpm', 'controlwardsbought', 'vspm', 'visionscore',
  'earned gpm', 'cspm', 'golddiffat15', 'xpdiffat15', 'csdiffat15', 'goldat15', 'csat15',
  'towers', 'barons', 'dragons',
];

/** Short keys in the bundle, so a year of rows is a sane size on disk. */
const SHORT = {
  gameid: 'g', date: 'd', league: 'lg', year: 'y', split: 'sp', playoffs: 'po', game: 'gn',
  position: 'pos', playername: 'p', playerid: 'pid', teamname: 't', champion: 'c',
  gamelength: 'len', result: 'w', kills: 'k', deaths: 'de', assists: 'a', teamkills: 'tk',
  dpm: 'dpm', damageshare: 'dsh', damagetakenperminute: 'dtpm',
  wpm: 'wpm', wcpm: 'wcpm', controlwardsbought: 'cw', vspm: 'vspm', visionscore: 'vs',
  'earned gpm': 'gpm', cspm: 'cspm', golddiffat15: 'gd15', xpdiffat15: 'xd15',
  csdiffat15: 'cd15', goldat15: 'g15', csat15: 'c15',
  towers: 'tow', barons: 'bar', dragons: 'drg',
};

/** RFC-4180-ish split. Team names and URLs contain commas, so a plain split corrupts rows. */
function splitCsv(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

async function ingestFile(file) {
  const path = join(IN_DIR, file);
  const bytes = statSync(path).size;

  // The exact bytes a catalogue was built from, so a rebuild can be shown to have used the
  // same file. docs/03 section 9 wants source hashes on the published version.
  const hash = createHash('sha256');
  await new Promise((res, rej) => {
    createReadStream(path).on('data', (c) => hash.update(c)).on('end', res).on('error', rej);
  });
  const sha256 = hash.digest('hex').slice(0, 16);

  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let index = null;
  const rows = [];
  const teams = [];
  const years = new Set();
  let total = 0;
  let incomplete = 0;
  let partial = 0;
  let teamRows = 0;

  for await (const line of rl) {
    if (index === null) {
      const header = splitCsv(line);
      index = {};
      const missing = COLUMNS.filter((c) => !header.includes(c));
      if (missing.length) {
        throw new Error(`${file}: missing required column(s): ${missing.join(', ')}.\n`
          + 'docs/03 section 3.1 expects this to happen eventually — map the new spelling '
          + 'rather than dropping the column, or every rating built on it silently flattens.');
      }
      for (const c of COLUMNS) index[c] = header.indexOf(c);
      continue;
    }
    if (!line) continue;
    const f = splitCsv(line);
    total++;

    /**
     * Oracle's Elixir marks a game `complete` or `partial`, and partial is not junk — it is
     * a game whose timeline Riot did not publish. The post-game scoreboard is all there:
     * damage, damage taken, vision, wards, gold and CS per minute. What is missing is the
     * lane difference at 15 minutes and the team objective counts, both of which need the
     * timeline.
     *
     * That distinction decides whether China is in this game at all. Every LPL game from
     * 2022 to 2024 is marked partial — 7,550 player rows in 2023 alone — so dropping partial
     * rows produced a catalogue with no Chinese players for four recent seasons, and no
     * JDG, BLG, TES or EDG cards. They are kept, and the columns a partial game cannot
     * supply stay null, which the cohort already knows how to treat as unmeasured rather
     * than as bad. Each affected card names them in provenance.unreported.
     */
    const completeness = f[index.datacompleteness];
    if (completeness !== 'complete' && completeness !== 'partial') { incomplete++; continue; }
    if (completeness === 'partial') partial++;

    const y = Number(f[index.year]);
    if (!wantedYear(y)) continue;

    // Team-aggregate rows share the schema with player rows, so they cannot be rated as if
    // they were a sixth player. They are kept separately because they are the only place
    // the objective counts live: towers, barons and dragons are blank on every player row.
    if (f[index.position] === 'team') {
      teams.push({
        g: f[index.gameid],
        t: f[index.teamname],
        tow: f[index.towers] || null,
        bar: f[index.barons] || null,
        drg: f[index.dragons] || null,
      });
      teamRows++;
      continue;
    }

    const row = {};
    for (const c of COLUMNS) {
      if (c === 'datacompleteness') continue;
      const v = f[index[c]];
      row[SHORT[c]] = v === '' ? null : v;
    }
    years.add(y);
    rows.push(row);
  }

  return { file, sha256, bytes, rows, teams, years: [...years].sort(), total, incomplete, partial, teamRows };
}

// --- main --------------------------------------------------------------------

if (!existsSync(IN_DIR)) {
  console.error(`no CSVs at ${IN_DIR}\n\n`
    + 'Download the yearly files from the Google Drive folder linked at\n'
    + 'https://oracleselixir.com/tools/downloads and put them there.');
  process.exit(1);
}

const files = readdirSync(IN_DIR).filter((f) => /_LoL_esports_match_data_from_OraclesElixir\.csv$/i.test(f)).sort();
if (!files.length) {
  console.error(`no Oracle's Elixir CSVs in ${IN_DIR}`);
  process.exit(1);
}

console.log(`in    ${IN_DIR} (${files.length} files)`);
console.log(`out   ${RAW_DIR}\n`);

mkdirSync(RAW_DIR, { recursive: true });

for (const file of files) {
  const { sha256, bytes, rows, teams, years, total, teamRows, incomplete, partial } = await ingestFile(file);
  if (!rows.length) {
    console.log(`${file}: no rows in the requested years, skipped`);
    continue;
  }
  const label = file.match(/^(\d{4})/)?.[1] || years[0];
  const out = join(RAW_DIR, `oe-${label}.json`);
  const bundle = {
    source: 'ORACLES_ELIXIR',
    attribution: 'Oracle\'s Elixir, aggregated and released by Tim Sevenhuysen (oracleselixir.com)',
    sourceFile: file,
    sha256,
    pulledAt: new Date().toISOString(),
    years,
    rows,
    teams,
  };
  writeFileSync(out, JSON.stringify(bundle), 'utf8');
  console.log(`${file} (${(bytes / 1e6).toFixed(0)} MB, sha ${sha256})`);
  console.log(`  -> oe-${label}.json — ${rows.length} player rows + ${teams.length} team rows, `
    + `${partial} from games with no timeline, seasons ${years.join(', ')}`);
}

console.log('\nDerive a catalogue from these bundles with:  npm run catalogue:build');
