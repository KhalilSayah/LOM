/**
 * Champion static data for the simulation: archetype, and the tags the composition
 * modifier reads.
 *
 *   npm run champions:build
 *
 * docs/04 section 2 says the engine holds no asset dependency and takes this table through
 * configureChampionData(). Nothing was ever calling it, which mattered more than it looks:
 * compositionFor() returns a flat 1.0 the moment a single champion is unknown, so every
 * draft in the game had exactly the same composition modifier and none of the shape of a
 * draft — frontline, engage, peel, damage types — did anything at all.
 *
 * Source is Data Dragon, which is already the source of champion art, so the table and the
 * pictures can never drift apart.
 *
 * What is honest about this file, and what is not:
 *
 *   - `archetype` and `damage` are derived from Riot's own `tags` and `info` numbers. A
 *     Marksman is a scaling carry; a champion whose magic rating beats its attack rating
 *     deals AP. These follow from the data.
 *   - `frontline`, `engage`, `peel` and `aoe` are *not* in Data Dragon in any form. They are
 *     inferred from class and stat profile, which gets the obvious cases right — Leona
 *     engages, Lulu peels, Malphite is frontline with AoE — and will be wrong about champions
 *     whose class says one thing and whose kit says another. They are an approximation
 *     standing in for a judgement nobody has written down yet, and a hand-maintained override
 *     file is the way to fix any specific champion that reads wrong.
 *
 * The overrides in CORRECTIONS below are exactly that: the cases where the heuristic is
 * plainly wrong and the champion is common enough in pro play for it to matter.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const DDRAGON = 'https://ddragon.leagueoflegends.com';

/**
 * Riot's class tags, mapped onto the five archetypes the sim's power curves use
 * (docs/04 section 5.1). Order matters: the first tag a champion has that appears
 * here wins, because Riot lists the primary class first.
 */
const ARCHETYPE_BY_TAG = {
  Marksman: 'SCALING_CARRY',
  Assassin: 'ASSASSIN',
  Tank: 'TANK',
  Fighter: 'SKIRMISHER',
  Mage: 'MAGE',
  Support: 'UTILITY',
};

/**
 * Champions the heuristic gets wrong often enough to be worth saying so.
 * Anything here is an editorial judgement, not derived data.
 */
const CORRECTIONS = {
  // Engage supports and tanks whose class alone does not say "starts the fight".
  Leona: { engage: true, frontline: true, aoe: true },
  Nautilus: { engage: true, frontline: true },
  Rakan: { engage: true, peel: true, aoe: true },
  Alistar: { engage: true, frontline: true, peel: true },
  Thresh: { engage: true, peel: true },
  Malphite: { engage: true, aoe: true, frontline: true },
  Amumu: { engage: true, aoe: true, frontline: true },
  Sejuani: { engage: true, aoe: true, frontline: true },
  Zac: { engage: true, aoe: true, frontline: true },
  Ornn: { engage: true, aoe: true, frontline: true },
  KSante: { engage: true, frontline: true, peel: true },
  Maokai: { engage: true, aoe: true, frontline: true },
  JarvanIV: { engage: true, aoe: true, frontline: true },
  Gragas: { engage: true, aoe: true },
  Rell: { engage: true, aoe: true, frontline: true },

  // Peel that the class tag misses.
  Lulu: { peel: true },
  Janna: { peel: true, engage: false },
  Milio: { peel: true },
  Renata: { peel: true, aoe: true },
  RenataGlasc: { peel: true, aoe: true },
  TahmKench: { peel: true, frontline: true },
  Braum: { peel: true, frontline: true },
  Karma: { peel: true },
  Yuumi: { peel: true, frontline: false },
  Soraka: { peel: true, frontline: false },
  Nami: { peel: true, aoe: true },

  // AoE damage that is the whole point of the pick.
  Orianna: { aoe: true, peel: true },
  Viktor: { aoe: true },
  Anivia: { aoe: true },
  Xerath: { aoe: true },
  Ziggs: { aoe: true },
  Brand: { aoe: true },
  'Miss Fortune': { aoe: true },
  MissFortune: { aoe: true },
  Samira: { aoe: true },
  Kennen: { aoe: true, engage: true },
  Galio: { aoe: true, engage: true, peel: true },

  // Carries that are emphatically not frontline whatever their fighter tag says.
  Yasuo: { frontline: false },
  Yone: { frontline: false },
  Akali: { frontline: false },
  Camille: { frontline: false },
  Irelia: { frontline: false },
  Riven: { frontline: false },
};

const slug = (name) => String(name).replace(/[^A-Za-z0-9]/g, '');

async function json(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'lom-champion-table/1.0' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function derive(champ) {
  const tags = champ.tags || [];
  const info = champ.info || {};

  const archetype = Object.keys(ARCHETYPE_BY_TAG).find((t) => tags.includes(t))
    ? ARCHETYPE_BY_TAG[tags.find((t) => ARCHETYPE_BY_TAG[t])]
    : 'UTILITY';

  // Riot rates every champion 1-10 on attack and magic. The larger one is how they
  // mostly deal damage; a close call is genuinely mixed.
  const attack = Number(info.attack || 0);
  const magic = Number(info.magic || 0);
  let damage = 'MIXED';
  if (attack - magic >= 3) damage = 'AD';
  else if (magic - attack >= 3) damage = 'AP';
  else if (tags.includes('Marksman')) damage = 'AD';
  else if (tags.includes('Mage')) damage = 'AP';

  // Heuristics, and the honest part of the file. A tank is frontline; a fighter is
  // frontline when Riot rates it tough. Engage follows frontline for tanks, peel
  // follows the support class, and AoE is assumed of mages.
  const tanky = Number(info.defense || 0) >= 6;
  const frontline = tags.includes('Tank') || (tags.includes('Fighter') && tanky);
  const engage = tags.includes('Tank') && tanky;
  const peel = tags.includes('Support');
  const aoe = tags.includes('Mage');

  const base = { frontline, engage, peel, aoe, damage };
  const fix = CORRECTIONS[champ.id] || CORRECTIONS[champ.name] || {};
  return { archetype, tags: { ...base, ...fix }, corrected: Object.keys(fix).length > 0 };
}

const versions = await json(`${DDRAGON}/api/versions.json`);
const version = versions[0];
console.log(`Data Dragon ${version}`);

const { data } = await json(`${DDRAGON}/cdn/${version}/data/en_US/champion.json`);

const table = {};
let corrected = 0;
for (const champ of Object.values(data)) {
  const entry = derive(champ);
  if (entry.corrected) corrected++;
  // Keyed by both the display name and the Data Dragon id, because the catalogue
  // stores "Miss Fortune" and the art layer stores "MissFortune", and a lookup that
  // only knows one of them silently falls back to the slot default.
  table[champ.name] = { archetype: entry.archetype, tags: entry.tags };
  table[slug(champ.name)] = { archetype: entry.archetype, tags: entry.tags };
  table[champ.id] = { archetype: entry.archetype, tags: entry.tags };
}

const out = {
  source: 'DATA_DRAGON',
  ddragonVersion: version,
  builtAt: new Date().toISOString(),
  note: 'archetype and damage are derived from Riot tags and info; frontline, engage, peel '
    + 'and aoe are inferred from class and stat profile and are an approximation. See '
    + 'scripts/build-champions.mjs.',
  champions: table,
};

mkdirSync(join(root, 'data'), { recursive: true });
writeFileSync(join(root, 'data/champions.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8');

const distinct = Object.values(data).length;
console.log(`wrote data/champions.json — ${distinct} champions (${Object.keys(table).length} lookup keys)`);
console.log(`  ${corrected} carry a hand-written correction`);
const counts = {};
for (const c of Object.values(data)) counts[derive(c).archetype] = (counts[derive(c).archetype] || 0) + 1;
console.log(`  archetypes  ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join('  ')}`);
