/**
 * The text play-by-play (docs/10 M1).
 *
 * This is the primary development interface for the engine, and the gate the
 * milestone is written against: if reading a random match here is not enjoyable, the
 * animated version will not be either — it will just take longer to find out.
 *
 *   node packages/sim/cli.mjs
 *   node packages/sim/cli.mjs --seed worlds-2024 --quiet
 *   node packages/sim/cli.mjs --blue path/to/team.json --red path/to/other.json
 */

import { readFileSync } from 'node:fs';
import { simulate } from './src/index.js';
import { TEAM_A, TEAM_B } from './fixtures/teams.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const load = (path, fallback) => (path ? JSON.parse(readFileSync(path, 'utf8')) : fallback);

const clock = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.round(t % 60)).padStart(2, '0')}`;

/** Events worth narrating at a glance, when --quiet trims the chatter. */
const HEADLINE = new Set([
  'FIRST_BLOOD', 'ACE', 'TOWER', 'INHIBITOR', 'NEXUS_TURRET', 'NEXUS',
  'DRAGON', 'SOUL', 'ELDER', 'BARON', 'HERALD', 'TEAMFIGHT_END', 'SUDDEN_DEATH', 'GAME_END',
]);

const result = simulate({
  seed: flag('seed', 'demo-match'),
  blue: load(flag('blue'), TEAM_A),
  red: load(flag('red'), TEAM_B),
});

const colour = (team) => (team === 'BLUE' ? '\x1b[36m' : team === 'RED' ? '\x1b[31m' : '');
const reset = '\x1b[0m';

console.log(`\n  LOM sim ${result.simVersion}  ·  seed ${flag('seed', 'demo-match')}\n`);

for (const event of result.events) {
  if (has('quiet') && !HEADLINE.has(event.type)) continue;
  if (!event.narration) continue;
  const tag = event.team ? `${colour(event.team)}${event.team.padEnd(4)}${reset}` : '    ';
  console.log(`  ${clock(event.t)}  ${tag}  ${event.narration}`);
}

const kills = (team) =>
  result.boxScore.filter((r) => r.team === team).reduce((n, r) => n + r.kills, 0);

console.log(`\n  ${colour(result.winner)}${result.winner} wins${reset} in ${clock(result.gameLength)}`
  + `  ·  ${kills('BLUE')}-${kills('RED')}  ·  ${result.endReason}\n`);

const header = '  player        champion     K/D/A      CS    gold   dmg%   vis  grade';
console.log(header);
console.log(`  ${'-'.repeat(header.length - 2)}`);

for (const team of ['BLUE', 'RED']) {
  for (const row of result.boxScore.filter((r) => r.team === team)) {
    console.log(
      `  ${colour(team)}${row.name.padEnd(13)}${reset}`
      + ` ${String(row.champion || '—').padEnd(12)}`
      + ` ${`${row.kills}/${row.deaths}/${row.assists}`.padEnd(9)}`
      + ` ${String(row.cs).padStart(5)}`
      + ` ${String(row.gold).padStart(7)}`
      + ` ${String(Math.round(row.damageShare * 100)).padStart(5)}`
      + ` ${String(row.vision).padStart(5)}`
      + `  ${row.grade}`,
    );
  }
  if (team === 'BLUE') console.log('');
}

console.log(
  `\n  comp  BLUE ${result.composition.blue.modifier.toFixed(3)}`
  + `  ·  RED ${result.composition.red.modifier.toFixed(3)}`
  + `  ·  ${result.events.length} events\n`,
);
