/**
 * docs/04 section 11. Run with `npm run sim:test`.
 *
 * node:test and node:assert, no dependencies and no build step — the same reason the
 * engine is plain ESM. The layers here are the ones the spec names: determinism,
 * invariants, fuzz and performance. The balance matrix is its own harness because it
 * takes minutes, not milliseconds.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { simulate, BALANCE } from '../src/index.js';
import { TEAM_A, TEAM_B, makeTeam } from '../fixtures/teams.mjs';
import { effRating, masteryFactor, rarityForOvr, gradeFor, roleFit } from '../../core/src/index.js';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const match = (seed = 'test-seed', blue = TEAM_A, red = TEAM_B) => simulate({ seed, blue, red });

// --- determinism -------------------------------------------------------------

test('same input and seed produce one distinct output', () => {
  const hashes = new Set();
  for (let i = 0; i < 50; i++) hashes.add(hash(match()));
  assert.equal(hashes.size, 1);
});

test('different seeds produce different matches', () => {
  const hashes = new Set();
  for (let i = 0; i < 20; i++) hashes.add(hash(match(`seed-${i}`)));
  assert.ok(hashes.size > 15, `expected varied matches, got ${hashes.size} distinct of 20`);
});

// --- invariants --------------------------------------------------------------

test('invariants hold across 200 matches', () => {
  for (let i = 0; i < 200; i++) {
    const result = match(`invariant-${i}`);
    const { events } = result;

    let last = -1;
    for (const event of events) {
      assert.ok(event.t >= last, `event time went backwards at ${event.type}`);
      assert.ok(event.t >= 0);
      last = event.t;
      if (event.pos) {
        assert.ok(event.pos.x >= 0 && event.pos.x <= 14870);
        assert.ok(event.pos.y >= 0 && event.pos.y <= 14870);
      }
      assert.equal(typeof event.narration, 'string');
    }

    assert.equal(events.filter((e) => e.type === 'GAME_END').length, 1);
    assert.equal(events[events.length - 1].type, 'GAME_END');
    assert.ok(['BLUE', 'RED'].includes(result.winner));
    assert.ok(result.gameLength <= BALANCE.maxGameLength);
    assert.equal(result.boxScore.length, 10);

    for (const row of result.boxScore) {
      assert.ok(row.gold >= 0, 'gold went negative');
      assert.ok(row.cs >= 0);
      assert.ok(row.deaths >= 0 && row.kills >= 0);
      assert.ok(row.damageShare >= 0 && row.damageShare <= 1);
    }
  }
});

test('structures fall from the outside in', () => {
  for (let i = 0; i < 100; i++) {
    const { events } = match(`structure-${i}`);
    const towers = { BLUE: {}, RED: {} };

    for (const event of events) {
      if (event.type === 'TOWER') {
        const lane = event.narration.includes('TOP') ? 'TOP' : event.narration.includes('BOT') ? 'BOT' : 'MID';
        towers[event.team][lane] = (towers[event.team][lane] || 0) + 1;
      }
      if (event.type === 'INHIBITOR') {
        const lane = event.narration.includes('TOP') ? 'TOP' : event.narration.includes('BOT') ? 'BOT' : 'MID';
        assert.equal(
          towers[event.team][lane],
          3,
          'an inhibitor fell before all three turrets on its lane',
        );
      }
      if (event.type === 'NEXUS') {
        const taken = events.filter((e) => e.type === 'NEXUS_TURRET' && e.team === event.team);
        assert.equal(taken.length, 2, 'the nexus fell before both nexus turrets');
      }
    }
  }
});

test('nobody kills after dying in the same fight', () => {
  // Respawns are state, not events, so this checks the window where aliveness is
  // unambiguous: between a teamfight starting and ending, nobody comes back.
  for (let i = 0; i < 100; i++) {
    const { events } = match(`actors-${i}`);
    let dead = null;

    for (const event of events) {
      if (event.type === 'TEAMFIGHT_START') dead = new Set();
      if (event.type === 'TEAMFIGHT_END') dead = null;

      if (event.type !== 'KILL' && event.type !== 'FIRST_BLOOD') continue;

      assert.notEqual(event.actors.killer, event.actors.victim, 'a player killed themselves');
      if (dead) {
        assert.ok(!dead.has(event.actors.killer), 'a dead player took a kill mid-fight');
        dead.add(event.actors.victim);
      }
    }
  }
});

// --- fuzz --------------------------------------------------------------------

test('degenerate drafts never throw and always finish', () => {
  const SLOTS = ['TOP', 'JNG', 'MID', 'BOT', 'SUP'];
  const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

  const degenerate = (i) => ({
    managerId: `fuzz-${i}`,
    strategy: ['STANDARD', 'AGGRESSIVE', 'SCALING'][rand(0, 2)],
    coach: null,
    players: SLOTS.map((slot) => ({
      cardKey: `fuzz-${rand(0, 999)}`,
      slot,
      // Unknown champions, missing sub-stats, ratings at both ends of the clamp.
      champion: rand(0, 1) ? null : 'NotAChampion',
      effRating: rand(30, 99),
      chemistry: rand(0, 1) ? 0 : 4.5,
      subStats: rand(0, 1) ? {} : { laning: 0, teamfight: 99, mechanics: 0, macro: 99, vision: 0, consistency: 0 },
    })),
  });

  for (let i = 0; i < 300; i++) {
    const result = simulate({ seed: `fuzz-${i}`, blue: degenerate(i), red: degenerate(i + 5000) });
    assert.ok(result.gameLength <= BALANCE.maxGameLength);
    assert.ok(['BLUE', 'RED'].includes(result.winner));
  }
});

test('five supports on off-role champions still resolve', () => {
  const allSup = (id) => ({
    managerId: id,
    strategy: 'STANDARD',
    coach: null,
    players: ['TOP', 'JNG', 'MID', 'BOT', 'SUP'].map((slot) => ({
      cardKey: `${id}-sup`,
      slot,
      champion: 'Braum',
      effRating: effRating({ ovr: 80, mastery: 0, championRole: 'SUP', slot }),
      chemistry: 0,
      subStats: { laning: 50, teamfight: 50, mechanics: 50, macro: 50, vision: 50, consistency: 50 },
    })),
  });

  const result = simulate({ seed: 'all-supports', blue: allSup('a'), red: allSup('b') });
  assert.ok(['BLUE', 'RED'].includes(result.winner));
});

// --- performance -------------------------------------------------------------

test('a match simulates well under 50 ms', () => {
  const times = [];
  for (let i = 0; i < 200; i++) {
    const start = process.hrtime.bigint();
    simulate({ seed: `perf-${i}`, blue: makeTeam('a', 75), red: makeTeam('b', 72) });
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  times.sort((a, b) => a - b);
  const p99 = times[Math.floor(times.length * 0.99)];
  assert.ok(p99 < 50, `p99 was ${p99.toFixed(1)} ms`);
});

// --- core formulas -----------------------------------------------------------

test('pool depth beats raw rating', () => {
  // docs/02 section 2.4, the crossover the whole collection design rests on.
  const unmastered = effRating({ ovr: 92, mastery: 0, championRole: 'MID', slot: 'MID' });
  const main = effRating({ ovr: 78, mastery: 95, championRole: 'MID', slot: 'MID' });
  assert.ok(main > unmastered, `${main} should beat ${unmastered}`);
  assert.ok(unmastered > 60 && unmastered < 70, `expected roughly 64, got ${unmastered}`);
});

test('mastery factor is monotonic and bounded', () => {
  let previous = 0;
  for (let m = 0; m <= 100; m += 5) {
    const factor = masteryFactor(m);
    assert.ok(factor >= previous);
    previous = factor;
  }
  assert.equal(masteryFactor(100), 1);
  assert.ok(masteryFactor(0) >= 0.7);
});

test('off-role costs more than adjacent-role', () => {
  assert.equal(roleFit('MID', 'MID'), 1);
  assert.ok(roleFit('JNG', 'MID') > roleFit('SUP', 'MID'));
});

test('rarity bands follow rating and accolades', () => {
  assert.equal(rarityForOvr(95, ['WORLDS_WINNER']), 'ICON');
  assert.equal(rarityForOvr(91), 'LEGENDARY');
  assert.equal(rarityForOvr(88, ['WORLDS_WINNER']), 'LEGENDARY');
  assert.equal(rarityForOvr(84), 'EPIC');
  assert.equal(rarityForOvr(76), 'RARE');
  assert.equal(rarityForOvr(60), 'COMMON');
});

test('grades are ordered', () => {
  assert.equal(gradeFor(2), 'S+');
  assert.equal(gradeFor(1.2), 'S');
  assert.equal(gradeFor(0.5), 'A');
  assert.equal(gradeFor(0), 'B');
  assert.equal(gradeFor(-0.8), 'C');
  assert.equal(gradeFor(-2), 'D');
});
