/**
 * Pulls season-matched player headshots from Leaguepedia into assets/portraits/.
 *
 *   node fetch-portraits.mjs
 *
 * ---------------------------------------------------------------------------------------
 * READ THIS BEFORE SHIPPING THESE IMAGES
 *
 * Leaguepedia tags player headshots `{{Copyright fairuse}}`. That is NOT a licence:
 *
 *   - The site-wide CC BY-SA 3.0 at fandom.com/licensing covers page TEXT. These files are
 *     explicitly excluded from it by their own licence template.
 *   - "Fair use" is a US defence, judged per use. The wiki's use (identifying a player on
 *     their own biography page) is a different use from ours (art on a collectible card in
 *     a game). The wiki's claim does not transfer to us.
 *   - The underlying photographs are Riot/team press shots. Depicted players also hold
 *     personality rights in several jurisdictions.
 *
 * This script records the licence tag and source URL for every file it downloads, in
 * assets/portraits/LICENCES.json, so the position is auditable rather than forgotten.
 *
 * Judgement for LOM as specified: the game is private (invite-only, 2-6 friends),
 * non-commercial, and has no purchasable content — docs/00-vision-and-scope.md section 7
 * makes all three permanent non-goals. That is a low-risk profile. It stops being low-risk
 * the moment the game is public or monetised, which is exactly when section 8.3 says to get
 * real advice.
 *
 * The engine does not require these. `USE_PORTRAITS = false` in samples/cards.js falls back
 * to champion art, which is cleanly licensed. Keep that path working.
 * ---------------------------------------------------------------------------------------
 */

import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'assets/portraits');
const API = 'https://lol.fandom.com/api.php';
const UA = 'LOM-card-engine/0.1 (non-commercial fan project)';

/**
 * The cards that want a portrait, and the season each should match.
 *
 * `file` pins an exact Leaguepedia filename instead of letting the season ranking choose.
 * Use it when you already hold a specific file and the provenance record must name that
 * one — the record is only worth keeping if it is accurate.
 */
const WANTED = [
  { cardKey: 'vetheo-2021', player: 'Vetheo', season: 2021 },
  { cardKey: 'wunder-2018', player: 'Wunder', season: 2018 },
  { cardKey: 'canyon-2022', player: 'Canyon', season: 2022 },
  { cardKey: 'ruler-2023', player: 'Ruler', season: 2023 },
  { cardKey: 'faker-2016', player: 'Faker', season: 2016, file: 'SKT Faker 2016 Spring.png' },
];

/** @param {Record<string,string>} params */
async function api(params) {
  const url = `${API}?${new URLSearchParams({ ...params, format: 'json' })}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  await new Promise((r) => setTimeout(r, 1100)); // be a good citizen: ~1 req/sec
  return res.json();
}

/** All headshots Leaguepedia has for a player. */
async function headshots(player) {
  const data = await api({
    action: 'cargoquery',
    tables: 'PlayerImages',
    fields: 'PlayerImages.Link,PlayerImages.FileName,PlayerImages.Tournament,PlayerImages.ImageType',
    where: `PlayerImages.Link='${player.replace(/'/g, "''")}'`,
    limit: '200',
  });
  return (data.cargoquery || [])
    .map((r) => r.title)
    .filter((r) => (r.ImageType || '').toLowerCase() === 'headshot');
}

/** Years mentioned anywhere in the filename or tournament string. */
function yearsIn(row) {
  const text = `${row.FileName || ''} ${row.Tournament || ''}`;
  return [...text.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
}

/**
 * Headshots ranked by distance from the card's season, closest first.
 *
 * A ranked list rather than one pick, because individual files on the CDN 403 while their
 * neighbours serve fine — the same player usually has several headshots for a season, so
 * falling through to the next candidate is the fix.
 */
function rankForSeason(rows, season) {
  return rows
    .map((row) => {
      const years = yearsIn(row);
      if (!years.length) return null;
      return { row, yearGap: Math.min(...years.map((y) => Math.abs(y - season))) };
    })
    .filter(Boolean)
    .sort((a, b) => a.yearGap - b.yearGap
      || String(a.row.FileName).localeCompare(String(b.row.FileName)));
}

/** File url + the licence template on its File: page. */
async function fileInfo(fileName) {
  const title = `File:${fileName}`;
  const info = await api({
    action: 'query',
    titles: title,
    prop: 'imageinfo|revisions',
    iiprop: 'url|mime|size',
    rvprop: 'content',
    rvslots: 'main',
  });
  const page = Object.values(info.query?.pages || {})[0];
  if (!page || page.missing !== undefined) return null;

  const ii = page.imageinfo?.[0];
  const wikitext = page.revisions?.[0]?.slots?.main?.['*'] || '';
  const licence = (wikitext.match(/\{\{(Copyright[^}|]*|[A-Za-z0-9 \-]*fairuse[^}|]*)\}\}/i) || [])[1]
    || 'UNDECLARED';

  return {
    title,
    descriptionUrl: `https://lol.fandom.com/wiki/${encodeURIComponent(title)}`,
    url: ii?.url?.split('/revision/')[0] || null,
    width: ii?.width,
    height: ii?.height,
    licence: licence.trim(),
  };
}

/**
 * `/revision/latest` is the canonical form the wikia CDN serves; the bare file path 403s.
 * Identify honestly — no browser-spoofed User-Agent, no forged Referer. If the host starts
 * refusing this agent, that is the host declining, and the answer is to stop, not to
 * disguise the client.
 * @param {string} url @param {string} destNoExt
 */
async function download(url, destNoExt) {
  // The image CDN rate-limits bursts with a 403. Space the requests out and back off
  // rather than hammering it.
  let res;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 4000 * attempt));
    res = await fetch(`${url}/revision/latest`, {
      headers: { 'User-Agent': UA, Accept: 'image/webp,image/png,image/*,*/*' },
    });
    if (res.ok) break;
    if (res.status !== 403 && res.status !== 429) break;
  }
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const type = res.headers.get('content-type') || '';
  const ext = type.includes('webp') ? 'webp' : type.includes('png') ? 'png' : 'jpg';
  const buf = Buffer.from(await res.arrayBuffer());
  const dest = `${destNoExt}.${ext}`;
  writeFileSync(dest, buf);
  return { dest, ext, bytes: buf.length, mime: type };
}

mkdirSync(outDir, { recursive: true });

const records = [];
let totalBytes = 0;

for (const want of WANTED) {
  const rows = await headshots(want.player);
  if (!rows.length) {
    console.warn(`! ${want.player}: no headshots on Leaguepedia`);
    continue;
  }

  const ranked = rankForSeason(rows, want.season);
  if (!ranked.length) {
    console.warn(`! ${want.player}: no dated headshot`);
    continue;
  }

  // Idempotent: a file already on disk is kept and re-recorded, never re-fetched.
  let dl = ['webp', 'png', 'jpg']
    .map((ext) => ({ dest: join(outDir, `${want.cardKey}.${ext}`), ext }))
    .filter((c) => existsSync(c.dest))
    .map((c) => ({ ...c, bytes: readFileSync(c.dest).length, mime: `image/${c.ext}`, cached: true }))[0];

  let pick = null;
  let info = null;

  const pinned = want.file
    ? ranked.find((c) => c.row.FileName === want.file)
      || { row: { FileName: want.file, Tournament: null }, yearGap: 0 }
    : null;

  if (dl) {
    pick = pinned || ranked[0];
    info = await fileInfo(pick.row.FileName);
  } else if (pinned) {
    const pinnedInfo = await fileInfo(pinned.row.FileName);
    if (pinnedInfo?.url) {
      try {
        await new Promise((r) => setTimeout(r, 2500));
        dl = await download(pinnedInfo.url, join(outDir, want.cardKey));
        pick = pinned;
        info = pinnedInfo;
      } catch (err) {
        console.warn(`! ${want.cardKey}: pinned ${want.file} refused (${err.message.replace(/^https:\S+ -> /, '')})`);
      }
    }
  } else {
    // Walk candidates closest-season-first until one actually serves. Individual files
    // 403 while their neighbours are fine, and a player usually has several per season.
    for (const candidate of ranked.slice(0, 6)) {
      const candidateInfo = await fileInfo(candidate.row.FileName);
      if (!candidateInfo?.url) continue;
      try {
        await new Promise((r) => setTimeout(r, 2500));
        dl = await download(candidateInfo.url, join(outDir, want.cardKey));
        pick = candidate;
        info = candidateInfo;
        break;
      } catch (err) {
        const why = err.message.replace(/^https:\S+ -> /, '');
        console.warn(`  · ${want.cardKey}: ${candidate.row.FileName} refused (${why}), trying next`);
      }
    }
  }

  if (!dl || !info) {
    console.warn(`! ${want.cardKey}: no candidate served (tried ${Math.min(ranked.length, 6)})`);
    continue;
  }
  totalBytes += dl.bytes;

  records.push({
    cardKey: want.cardKey,
    player: want.player,
    season: want.season,
    file: dl.dest.replace(/.*assets[\\/]/, 'assets/').replace(/\\/g, '/'),
    mime: dl.mime,
    bytes: dl.bytes,
    dimensions: info.width && info.height ? `${info.width}x${info.height}` : null,
    sourceFile: info.title,
    sourceTournament: pick.row.Tournament,
    yearGap: pick.yearGap,
    descriptionUrl: info.descriptionUrl,
    fileUrl: info.url,
    licence: info.licence,
    attribution: 'Leaguepedia (lol.fandom.com)',
  });

  const flag = pick.yearGap === 0 ? '' : `  (nearest season, ${pick.yearGap}y off)`;
  const how = dl.cached ? 'on disk' : 'downloaded';
  console.log(`  ${want.cardKey}  ${pick.row.FileName}  [${info.licence}] ${how}${flag}`);
}

writeFileSync(
  join(outDir, 'LICENCES.json'),
  JSON.stringify({
    warning:
      'Leaguepedia tags these files Copyright fairuse. That is a claim about the WIKI\'s use, '
      + 'not a licence granted to this project. See the header of fetch-portraits.mjs. '
      + 'Underlying photographs are Riot/team press shots; depicted players hold personality rights.',
    fetchedAt: new Date().toISOString(),
    source: 'https://lol.fandom.com (Leaguepedia), PlayerImages table',
    files: records,
  }, null, 2),
);

console.log(
  `\n${records.length}/${WANTED.length} portraits, ${(totalBytes / 1024).toFixed(0)} KB`,
);
console.log(`Licences recorded in assets/portraits/LICENCES.json — read it before publishing.`);
