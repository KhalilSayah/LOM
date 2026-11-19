/**
 * Upload data/catalogue.json into Supabase and make it the active catalogue.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/push-catalogue.mjs
 *   node scripts/push-catalogue.mjs --file data/catalogue.test.json --no-activate
 *
 * Idempotent: re-running with the same semver updates the rows in place. Activation is a
 * separate step so a catalogue can be loaded and inspected before anyone opens a pack
 * against it.
 *
 * Needs the service-role key. It writes to tables the anon key cannot touch, which is the
 * point: the catalogue is not user data.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const FILE = flag('file', 'data/catalogue.json');
const ACTIVATE = !argv.includes('--no-activate');
const CHUNK = 200;

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

if (!url || !key) {
  console.error([
    'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY.',
    '',
    'Put them in .env (gitignored), either by hand from',
    'Supabase > Project settings > API, or with:',
    '',
    '  npx vercel link && npx vercel env pull .env.local',
    '',
    'The secret / service_role key bypasses row-level security. It belongs in that',
    "file and in your host's environment, nowhere else.",
  ].join('\n'));
  process.exit(1);
}

const db = createClient(url, key, { auth: { persistSession: false } });

const catalogue = JSON.parse(readFileSync(join(root, FILE), 'utf8'));
const { semver, cards } = catalogue;

console.log(`${FILE}: ${cards.length} cards, catalogue ${semver} (${catalogue.source})`);

// --- 1. the version row ------------------------------------------------------

const { data: version, error: versionError } = await db
  .from('catalogue_versions')
  .upsert(
    {
      semver,
      source: catalogue.source || 'SEED',
      notes: catalogue.notes || null,
      built_at: catalogue.builtAt || new Date().toISOString(),
    },
    { onConflict: 'semver' },
  )
  .select('id, semver')
  .single();

if (versionError) {
  console.error('catalogue_versions:', versionError.message);
  process.exit(1);
}

// A semver is meant to identify one build. If this version already holds cards, this is a
// re-push: the upserts below will update every card in the file, but a card that was in the
// earlier build and is not in this one stays behind, and it cannot simply be deleted because
// collection_cards cascades off card_definitions and someone may own it.
//
// So this reports rather than repairs. Build under a fresh semver (CATALOGUE_SEMVER=...) if
// the card list has changed.
const { count: existing } = await db
  .from('card_definitions')
  .select('id', { count: 'exact', head: true })
  .eq('catalogue_version_id', version.id);

if (existing) {
  console.log(`  version ${semver} already holds ${existing} cards — re-pushing over it`);
  if (existing > cards.length) {
    console.warn(`! ${existing - cards.length} cards in that version are not in this file. `
      + 'They stay as they are: owned cards reference them. Use a new semver for a clean version.');
  }
}

// --- 2. card definitions -----------------------------------------------------

const definitions = cards.map((c) => ({
  catalogue_version_id: version.id,
  card_key: c.cardKey,
  kind: c.kind || 'PLAYER',
  player_name: c.playerName,
  real_name: c.realName || null,
  season: c.season,
  team: c.team,
  region: c.region,
  role: c.role,
  ovr: c.ovr,
  rarity: c.rarity,
  sub_stats: c.subStats,
  accolades: c.accolades || [],
  season_summary: c.seasonSummary || {},
  provenance: c.provenance || {},
  art_champion_key: c.artChampionKey,
  art_focus: c.artFocus,
}));

let written = 0;
for (let i = 0; i < definitions.length; i += CHUNK) {
  const slice = definitions.slice(i, i + CHUNK);
  const { error } = await db
    .from('card_definitions')
    .upsert(slice, { onConflict: 'catalogue_version_id,card_key' });
  if (error) {
    console.error(`card_definitions [${i}..]:`, error.message);
    process.exit(1);
  }
  written += slice.length;
  process.stdout.write(`\r  cards ${written}/${definitions.length}`);
}
process.stdout.write('\n');

// --- 3. champion pools -------------------------------------------------------

// PostgREST caps a response at 1000 rows, so this has to be paged. Without it a full
// catalogue silently loses the champion pool of every card past the first thousand.
const idByKey = new Map();
for (let from = 0; ; from += 1000) {
  const { data: ids, error: idsError } = await db
    .from('card_definitions')
    .select('id, card_key')
    .eq('catalogue_version_id', version.id)
    .range(from, from + 999);

  if (idsError) {
    console.error('reading back card ids:', idsError.message);
    process.exit(1);
  }
  for (const row of ids) idByKey.set(row.card_key, row.id);
  if (ids.length < 1000) break;
}

if (idByKey.size !== cards.length) {
  console.warn(`! read back ${idByKey.size} ids for ${cards.length} cards`);
}

const pool = cards.flatMap((c) => (c.championPool || []).map((p) => ({
  card_definition_id: idByKey.get(c.cardKey),
  champion_key: p.championKey,
  champion_name: p.championName,
  games: p.games,
  winrate: p.winrate,
  mastery: p.mastery,
  slot: p.slot ?? 0,
})).filter((p) => p.card_definition_id));

let pooled = 0;
for (let i = 0; i < pool.length; i += CHUNK * 2) {
  const slice = pool.slice(i, i + CHUNK * 2);
  const { error } = await db
    .from('card_champion_pool')
    .upsert(slice, { onConflict: 'card_definition_id,champion_key' });
  if (error) {
    console.error(`card_champion_pool [${i}..]:`, error.message);
    process.exit(1);
  }
  pooled += slice.length;
  process.stdout.write(`\r  pool  ${pooled}/${pool.length}`);
}
process.stdout.write('\n');

// --- 4. activate -------------------------------------------------------------

if (ACTIVATE) {
  // The partial unique index allows exactly one active row, so stand the old one down first.
  await db.from('catalogue_versions').update({ is_active: false }).eq('is_active', true);
  const { error } = await db
    .from('catalogue_versions')
    .update({ is_active: true })
    .eq('id', version.id);
  if (error) {
    console.error('activating:', error.message);
    process.exit(1);
  }
  console.log(`\ncatalogue ${semver} is now active — packs roll against it.`);
} else {
  console.log(`\ncatalogue ${semver} loaded but not active (--no-activate).`);
}
