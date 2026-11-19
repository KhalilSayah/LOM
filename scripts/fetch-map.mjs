/**
 * Pulls the Summoner's Rift minimap from Riot's Data Dragon into public/map/.
 *
 *   node scripts/fetch-map.mjs
 *
 * Same source and same reasoning as packages/card-engine/fetch-assets.mjs: Data Dragon
 * is Riot's own public CDN and the intended source for map and champion art in a
 * community project (docs/03 section 1, S3). The app already carries the attribution
 * line this requires.
 *
 * The replay draws whatever PNG is at public/map/rift.png. Swapping in a higher
 * resolution render is a file copy: drop a square image there and the renderer scales
 * it to the canvas. What it cannot guess is how the new image frames the map — if the
 * base corners sit further in or further out than this one, the markers drift off the
 * lanes. That is the four numbers in `BOUNDS` in app/components/RiftMap.vue, and
 * /map-check.html exists to find them: it draws the markers over the art with the
 * bounds as live inputs, so you nudge until the structures sit where they belong.
 */

import { mkdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '../public/map');
const outFile = join(outDir, 'rift.png');

// Pinned, like the champion art in the card pages: an unpinned "latest" would change
// the map under a replay that was recorded against the old one.
const VERSION = '16.22.1';
const URL = `https://ddragon.leagueoflegends.com/cdn/${VERSION}/img/map/map11.png`;

// Any rift.* counts as "there is already a map here", so fetching the default never
// quietly reinstates Riot's minimap over a render somebody dropped in — and never
// leaves two files where the renderer would pick the wrong one.
const existing = ['png', 'jpg', 'jpeg', 'webp']
  .map((ext) => join(outDir, `rift.${ext}`))
  .find((path) => existsSync(path));

if (existing && !process.argv.includes('--force')) {
  const { size } = statSync(existing);
  console.log(`already have ${basename(existing)} in public/map `
    + `(${(size / 1024).toFixed(0)} kB) — pass --force to replace it with Riot's minimap`);
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });

const response = await fetch(URL);
if (!response.ok) {
  console.error(`Data Dragon said ${response.status} for ${URL}`);
  process.exit(1);
}

const bytes = Buffer.from(await response.arrayBuffer());

// A map that is not a PNG is a CDN error page with a 200 on it, and writing it would
// fail much later and much less clearly, as a blank canvas.
if (bytes.length < 1024 || bytes[0] !== 0x89 || bytes[1] !== 0x50) {
  console.error(`that was not a PNG (${bytes.length} bytes)`);
  process.exit(1);
}

writeFileSync(outFile, bytes);
console.log(`wrote public/map/rift.png — ${(bytes.length / 1024).toFixed(0)} kB from Data Dragon ${VERSION}`);
