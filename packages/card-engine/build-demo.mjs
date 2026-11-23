/**
 * Builds a single self-contained demo page from the engine sources.
 *
 *   node build-demo.mjs            -> dist/demo.html
 *
 * The sources stay idiomatic ES modules; this inlines them by concatenating in dependency
 * order and dropping the module syntax. That is only safe because the sources follow two
 * rules, which the script asserts:
 *   - imports are single-line `import { a, b } from './x.js';`
 *   - exports are `export function` / `export const` / `export { ... } from './x.js'`
 * No default exports, no import renaming, no name collisions across files.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * --cdn skips asset inlining and lets the engine's default Data Dragon resolver run. The
 * output is ~60 KB instead of ~1.8 MB, which is what you want for a quick local look; the
 * published page needs the inlined build because its host blocks remote images.
 */
const CDN_MODE = process.argv.includes('--cdn');

/**
 * --pack builds the pack-opening page instead of the card sheet. Same engine, same
 * inlined art, different shell: dist/pack.html.
 */
const PACK_MODE = process.argv.includes('--pack');
const SHELL = PACK_MODE ? 'demo/pack-shell.html' : 'demo/shell.html';
const OUT_NAME = PACK_MODE
  ? (CDN_MODE ? 'pack.cdn.html' : 'pack.html')
  : (CDN_MODE ? 'demo.cdn.html' : 'demo.html');

// Dependency order matters at evaluation time: a file may only use names defined above it.
// (Functions are hoisted, so a call made later is fine; a top-level const is not.)
const MODULES = [
  'src/rng.js',
  'src/assets.js',
  'src/rarity.js',
  'src/artwork.js',
  'src/template.js',
  'src/tilt.js',
  'src/card.js',
  'src/pack-art.js',
  'src/pack-foil.js',
  'src/pack.js',
  'src/index.js',
  'samples/cards.js',
];

// Stylesheets, concatenated in this order.
const STYLES = ['src/card.css', 'src/pack.css'];

const RE_IMPORT = /^\s*import\s+\{[^}]*\}\s+from\s+['"][^'"]+['"];?\s*$/gm;
const RE_REEXPORT = /^\s*export\s+\{[^}]*\}\s+from\s+['"][^'"]+['"];?\s*$/gm;
const RE_EXPORT_KEYWORD = /^(\s*)export\s+(?=(?:async\s+)?(?:function|const|let|class))/gm;

/** @param {string} src @param {string} name */
function stripModuleSyntax(src, name) {
  const out = src
    .replace(RE_REEXPORT, '')
    .replace(RE_IMPORT, '')
    .replace(RE_EXPORT_KEYWORD, '$1');

  const leftover = out.match(/^\s*(import|export)\s/m);
  if (leftover) {
    throw new Error(
      `${name}: module syntax survived the transform near "${leftover[0].trim()}". `
      + 'Keep imports and exports to the single-line forms this builder understands.',
    );
  }
  return `/* ===== ${name} ===== */\n${out.trim()}\n`;
}

/**
 * Champion art has to travel inside the file. The demo is published as a single page to a
 * host that blocks remote images, so a live Data Dragon URL would simply not render. The
 * engine's asset resolver exists exactly so this swap costs nothing.
 */
/**
 * Player portraits, where one has been fetched. Absent is the normal case and not an
 * error: the card falls back to champion art, which is cleanly licensed.
 */
function inlinePortraits() {
  const map = {};
  const licences = [];
  let bytes = 0;
  let count = 0;
  const dir = join(here, 'assets/portraits');
  if (!existsSync(dir)) return { map, bytes, count, licences };

  const lic = join(dir, 'LICENCES.json');
  const known = existsSync(lic) ? JSON.parse(readFileSync(lic, 'utf8')).files || [] : [];

  for (const entry of readdirSync(dir)) {
    const m = entry.match(/^(.+)\.(webp|png|jpg|jpeg)$/i);
    if (!m) continue;
    const buf = readFileSync(join(dir, entry));
    const ext = m[2].toLowerCase();
    map[m[1]] = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${buf.toString('base64')}`;
    bytes += buf.length;
    count++;
    const rec = known.find((k) => k.cardKey === m[1]);
    licences.push(`${m[1]}: ${rec ? `${rec.sourceFile} [${rec.licence}]` : 'no licence record'}`);
  }
  return { map, bytes, count, licences };
}

function inlineAssets() {
  const dir = join(here, 'assets/ddragon');
  const manifestPath = join(dir, 'manifest.json');
  // Portraits are always inlined, including in --cdn mode: they are local files with no
  // public URL to point at.
  if (CDN_MODE) {
    console.log('- cdn mode: champion art loads from Data Dragon at runtime');
    const p = inlinePortraits();
    return {
      block: p.count
        ? `\nconst PORTRAIT_INLINE = ${JSON.stringify(p.map)};\n`
          + 'setAssetResolver({ portrait: (cardKey) => PORTRAIT_INLINE[cardKey] || null });\n'
        : '',
      bytes: p.bytes,
      count: p.count,
      licences: p.licences,
    };
  }
  if (!existsSync(manifestPath)) {
    console.warn('! assets/ddragon/manifest.json missing — run `node fetch-assets.mjs` first.');
    console.warn('! Building without inlined art; cards fall back to generated artwork.');
    return { block: '', bytes: 0, count: 0, licences: [] };
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const map = { splash: {}, square: {} };
  let bytes = 0;
  let count = 0;

  const add = (kind, id, file, mime) => {
    const path = join(dir, kind, file);
    if (!existsSync(path)) {
      console.warn(`! missing ${kind}/${file}`);
      return;
    }
    const buf = readFileSync(path);
    map[kind][id] = `data:${mime};base64,${buf.toString('base64')}`;
    bytes += buf.length;
    count++;
  };

  for (const id of manifest.splash) add('splash', id, `${id}.jpg`, 'image/jpeg');
  for (const id of manifest.square) add('square', id, `${id}.png`, 'image/png');

  const p = inlinePortraits();
  const portraits = p.map;
  bytes += p.bytes;
  count += p.count;
  const licences = p.licences;

  const block = `
/* ===== inlined Data Dragon ${manifest.version} assets ===== */
const DDRAGON_INLINE = ${JSON.stringify(map)};
const PORTRAIT_INLINE = ${JSON.stringify(portraits)};
setAssetResolver({
  splash: (k) => DDRAGON_INLINE.splash[k] || null,
  square: (k) => DDRAGON_INLINE.square[k] || null,
  portrait: (cardKey) => PORTRAIT_INLINE[cardKey] || null,
});
`;
  return { block, bytes, count, licences };
}

const assets = inlineAssets();

const engine = MODULES
  .map((rel) => stripModuleSyntax(readFileSync(join(here, rel), 'utf8'), rel))
  .join('\n') + assets.block;

const css = STYLES.map((rel) => readFileSync(join(here, rel), 'utf8')).join('\n');
const shell = readFileSync(join(here, SHELL), 'utf8');

if (!shell.includes('/*@CARD_CSS@*/')) throw new Error(`${SHELL}: missing /*@CARD_CSS@*/ marker`);
if (!shell.includes('//@ENGINE@')) throw new Error(`${SHELL}: missing //@ENGINE@ marker`);

const html = shell
  .replace('/*@CARD_CSS@*/', css)
  .replace('//@ENGINE@', engine);

mkdirSync(join(here, 'dist'), { recursive: true });
const out = join(here, 'dist', OUT_NAME);
writeFileSync(out, html, 'utf8');

const mb = (Buffer.byteLength(html, 'utf8') / 1024 / 1024).toFixed(2);
console.log(
  `built ${out}  (${mb} MB — ${MODULES.length} modules, `
  + `${assets.count} images / ${(assets.bytes / 1024 / 1024).toFixed(2)} MB of art)`,
);
if (Buffer.byteLength(html, 'utf8') > 15 * 1024 * 1024) {
  throw new Error('page exceeds the 16 MB artifact limit — downscale the splash art');
}
if (assets.licences?.length) {
  console.log('\nPlayer portraits baked into this build:');
  for (const line of assets.licences) console.log(`  ${line}`);
  console.log('  These are not freely licensed. See assets/portraits/LICENCES.json.');
}
