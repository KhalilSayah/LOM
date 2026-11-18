/**
 * Merge per-year catalogues into one.
 *
 *   node scripts/merge-catalogues.mjs .data/years data/catalogue.json
 *
 * The ingest runs one year at a time on purpose: a rating is a percentile inside a cohort,
 * and the right cohort for a 2014 bot laner is other 2014 bot laners, not the 2024 ones.
 * Pooling every year into one cohort would rank eras against each other and quietly push
 * older seasons down as the stat baselines moved. So each year is normalised on its own and
 * the results are concatenated here.
 *
 * Running year by year also means a run that dies at year nine keeps the first eight.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const inDir = join(root, process.argv[2] || '.data/years');
const outFile = join(root, process.argv[3] || 'data/catalogue.json');

if (!existsSync(inDir)) {
  console.error(`no such directory: ${inDir}`);
  process.exit(1);
}

const files = readdirSync(inDir).filter((f) => f.endsWith('.json')).sort();
if (!files.length) {
  console.error(`nothing to merge in ${inDir}`);
  process.exit(1);
}

const cards = [];
const seen = new Map();
const years = [];
let skipped = 0;

for (const file of files) {
  const part = JSON.parse(readFileSync(join(inDir, file), 'utf8'));
  years.push(file.replace(/\D+/g, ''));
  for (const card of part.cards) {
    // A player-season is unique by construction, but a tournament that straddles new year
    // can produce the same key twice. Keep the one with more games behind it.
    const existing = seen.get(card.cardKey);
    if (existing) {
      skipped++;
      if ((card.provenance?.games || 0) > (existing.provenance?.games || 0)) {
        cards[cards.indexOf(existing)] = card;
        seen.set(card.cardKey, card);
      }
      continue;
    }
    seen.set(card.cardKey, card);
    cards.push(card);
  }
}

cards.sort((a, b) => b.ovr - a.ovr || a.cardKey.localeCompare(b.cardKey));

const bands = {};
const roles = {};
const bySeason = {};
for (const c of cards) {
  bands[c.rarity] = (bands[c.rarity] || 0) + 1;
  roles[c.role] = (roles[c.role] || 0) + 1;
  bySeason[c.season] = (bySeason[c.season] || 0) + 1;
}

const sortedYears = years.filter(Boolean).sort();
const semver = process.env.CATALOGUE_SEMVER
  || `${sortedYears[0]}-${sortedYears[sortedYears.length - 1]}.${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;

const out = {
  semver,
  builtAt: new Date().toISOString(),
  source: 'LEAGUEPEDIA',
  notes: `Merged from ${files.length} per-year ingests (${sortedYears[0]}-${sortedYears[sortedYears.length - 1]}). `
    + 'Each year was normalised against its own role cohorts, so a rating is relative to the '
    + 'players of that season rather than to every season at once.',
  counts: { cards: cards.length, bands, roles, bySeason },
  cards,
};

writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`, 'utf8');

console.log(`merged ${files.length} years -> ${cards.length} cards, catalogue ${semver}`);
if (skipped) console.log(`  ${skipped} duplicate card keys collapsed`);
console.log(`  bands  ${Object.entries(bands).map(([k, v]) => `${k} ${v}`).join('  ')}`);
console.log(`  roles  ${Object.entries(roles).map(([k, v]) => `${k} ${v}`).join('  ')}`);
