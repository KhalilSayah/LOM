/**
 * Pulls champion art from Riot's Data Dragon CDN into assets/ddragon/.
 *
 *   node fetch-assets.mjs
 *
 * Data Dragon is Riot's own public CDN and is the intended source for champion art in a
 * community project (docs/03-data-pipeline.md section 1, S3). Nothing here touches player
 * photographs, which are a separate rights question — see section 8.2.
 *
 * Re-running is cheap: files already on disk are skipped.
 */

import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'assets/ddragon');

/** Champion art needed by samples/cards.js. Keys are Data Dragon ids. */
const SPLASH = ['Syndra', 'Aatrox', 'Viego', 'Aphelios', 'Ryze'];
const SQUARE = [
  'Syndra', 'Akali', 'Orianna', 'Sylas',
  'Aatrox', 'Jayce', 'Sion', 'Urgot',
  'Viego', 'LeeSin', 'Graves', 'Hecarim',
  'Aphelios', 'Zeri', 'Jinx', 'Kaisa',
  'Ryze', 'Viktor', 'Cassiopeia', 'Leblanc',
];

async function latestVersion() {
  const res = await fetch('https://ddragon.leagueoflegends.com/api/versions.json');
  if (!res.ok) throw new Error(`versions.json: ${res.status}`);
  const versions = await res.json();
  return versions[0];
}

/** @param {string} url @param {string} dest */
async function download(url, dest) {
  if (existsSync(dest)) {
    return { dest, bytes: readFileSync(dest).length, cached: true };
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return { dest, bytes: buf.length, cached: false };
}

const version = await latestVersion();
mkdirSync(join(outDir, 'splash'), { recursive: true });
mkdirSync(join(outDir, 'square'), { recursive: true });

let total = 0;
let fetched = 0;

for (const id of SPLASH) {
  const r = await download(
    `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${id}_0.jpg`,
    join(outDir, 'splash', `${id}.jpg`),
  );
  total += r.bytes;
  if (!r.cached) fetched++;
}

for (const id of SQUARE) {
  const r = await download(
    `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${id}.png`,
    join(outDir, 'square', `${id}.png`),
  );
  total += r.bytes;
  if (!r.cached) fetched++;
}

writeFileSync(
  join(outDir, 'manifest.json'),
  JSON.stringify({ version, splash: SPLASH, square: SQUARE, fetchedAt: new Date().toISOString() }, null, 2),
);

console.log(
  `Data Dragon ${version}: ${SPLASH.length} splash + ${SQUARE.length} square `
  + `(${fetched} downloaded, ${(total / 1024 / 1024).toFixed(2)} MB on disk)`,
);
