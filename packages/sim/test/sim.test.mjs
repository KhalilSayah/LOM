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

import { simulate, BALANCE, SIM_VERSION } from '../src/index.js';
import { laneOfEvent, structuresAt, buildTracks, positionsAt, winChance, winPriors } from '../src/replay.js';
import { STRUCTURES, structurePos } from '../src/map.js';
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
        assert.ok(['TOP', 'MID', 'BOT'].includes(event.payload?.lane), 'a turret event without its lane');
        const lane = laneOfEvent(event);
        towers[event.team][lane] = (towers[event.team][lane] || 0) + 1;
      }
      if (event.type === 'INHIBITOR') {
        const lane = laneOfEvent(event);
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

test('kills and assists come from the players in the fight', () => {
  for (let i = 0; i < 100; i++) {
    const { events } = match(`fighters-${i}`);
    let inFight = null;

    for (const event of events) {
      if (event.type === 'TEAMFIGHT_START') inFight = new Set(event.actors.participants);
      if (event.type === 'TEAMFIGHT_END') inFight = null;
      if (event.type !== 'KILL' && event.type !== 'FIRST_BLOOD') continue;
      if (!inFight) continue;

      // The late-arrival fallback exists for a side wiped to the last player; it is
      // the exception, so the assertion is on the people credited, not on its absence.
      for (const pid of event.actors.assists) {
        assert.ok(inFight.has(pid), `${pid} assisted a teamfight kill without being in the fight`);
      }
      assert.ok(!event.actors.assists.includes(event.actors.killer), 'a killer assisted their own kill');
    }
  }
});

test('assists and farm look like the roles that earn them', () => {
  const by = {};
  for (let i = 0; i < 300; i++) {
    const result = match(`roles-${i}`);
    const minutes = result.gameLength / 60;
    for (const row of result.boxScore) {
      const s = (by[row.slot] ||= { a: 0, kp: 0, cs: 0, n: 0 });
      s.a += row.assists;
      s.kp += row.killParticipation;
      s.cs += row.cs / minutes;
      s.n += 1;
    }
  }
  const avg = (slot, key) => by[slot][key] / by[slot].n;

  assert.ok(avg('SUP', 'a') > avg('TOP', 'a'), 'a support should out-assist a top laner');
  assert.ok(avg('JNG', 'kp') > avg('TOP', 'kp'), 'a jungler should be in more of the kills than top');
  assert.ok(avg('SUP', 'kp') > 0.5, `support kill participation ${avg('SUP', 'kp').toFixed(2)}`);

  const window = { TOP: [6.8, 8.4], JNG: [5, 6.6], MID: [7.8, 9.6], BOT: [8, 10], SUP: [0.7, 1.8] };
  for (const [slot, [low, high]] of Object.entries(window)) {
    const cs = avg(slot, 'cs');
    assert.ok(cs >= low && cs <= high, `${slot} farms ${cs.toFixed(2)} a minute, wanted ${low}-${high}`);
  }
});

test('the words never move the match', () => {
  for (let i = 0; i < 20; i++) {
    const seed = `words-${i}`;
    const plain = simulate({ seed, blue: TEAM_A, red: TEAM_B });
    const other = simulate({ seed, blue: TEAM_A, red: TEAM_B }, { saySeed: `different-${i}` });
    const shape = (r) => ({
      winner: r.winner,
      length: r.gameLength,
      box: r.boxScore,
      events: r.events.map(({ narration, ...rest }) => rest),
    });
    assert.deepEqual(shape(other), shape(plain));
    assert.notEqual(
      plain.events.map((e) => e.narration).join('|'),
      other.events.map((e) => e.narration).join('|'),
    );
  }
});

test('the commentary varies with what happened', () => {
  const shapes = {};
  for (let i = 0; i < 200; i++) {
    for (const e of match(`talk-${i}`).events) {
      (shapes[e.type] ||= new Set()).add(e.narration.replace(/\b[A-Z][\w']*\b/g, 'X'));
    }
  }
  assert.ok(shapes.TEAMFIGHT_END.size >= 10, `only ${shapes.TEAMFIGHT_END.size} ways to end a fight`);
  assert.ok(shapes.SKIRMISH.size >= 10, `only ${shapes.SKIRMISH.size} ways to describe a skirmish`);
  assert.ok(shapes.KILL.size >= 15);

  // Broadcast English, not the engine's own vocabulary.
  for (const type of ['PLATE', 'TOWER', 'GANK', 'INHIBITOR']) {
    for (const line of shapes[type] || []) {
      assert.ok(!/\b(TOP|MID|BOT|SUP|JNG)\b/.test(line), `code-speak in ${type}: ${line}`);
    }
  }
});

test('big moments are announced', () => {
  let multi = 0;
  for (let i = 0; i < 100; i++) {
    const { events } = match(`moments-${i}`);
    assert.equal(events.filter((e) => e.type === 'FIRST_BLOOD').length, 1, 'one first blood a game');

    for (const [n, e] of events.entries()) {
      if (e.type !== 'MULTIKILL') continue;
      multi += 1;
      assert.ok(e.payload.count >= 2 && e.payload.count <= 5);
      // The kills it counts come just before it, by the same player.
      const recent = events.slice(Math.max(0, n - 12), n)
        .filter((k) => (k.type === 'KILL' || k.type === 'FIRST_BLOOD') && k.actors.killer === e.actors.killer);
      assert.ok(recent.length >= e.payload.count, 'a multikill without the kills');
    }

    for (const e of events) {
      if (['DRAGON', 'BARON', 'HERALD', 'ELDER'].includes(e.type)) {
        assert.ok(e.actors?.participants?.length, `${e.type} with nobody taking it`);
      }
      if (e.payload?.stolen) assert.ok(e.actors.killer, 'a steal with no stealer');
    }
  }
  assert.ok(multi > 0, 'no multikill in a hundred games');
});

test('nobody acts on the map while the engine has them dead', () => {
  for (let i = 0; i < 100; i++) {
    const result = match(`graves-${i}`);
    const downUntil = new Map();
    for (const e of result.events) {
      const acting = !e.pos ? [] : [e.actors?.killer, ...(e.actors?.participants || [])].filter(Boolean);
      for (const pid of acting) {
        const until = downUntil.get(pid);
        assert.ok(!until || e.t >= until - BALANCE.tick, `${pid} in ${e.type} at ${e.t}, dead until ${until}`);
      }
      if (e.type === 'KILL' || e.type === 'FIRST_BLOOD') {
        assert.ok(e.payload.respawnAt > e.t - BALANCE.tick, 'respawn before the death');
        downUntil.set(e.actors.victim, e.payload.respawnAt);
      }
    }
  }
});

test('objectives are stamped when they happen, not when they will spawn', () => {
  for (let i = 0; i < 100; i++) {
    const { events } = match(`stamps-${i}`);
    for (let n = 1; n < events.length; n++) {
      // A tick's events are nudged a second apart, so a long run of +1 stamps is the
      // symptom of something stamped in the future dragging everything behind it.
      const gap = events[n].t - events[n - 1].t;
      assert.ok(gap >= 0);
    }
    let run = 0;
    let worst = 0;
    for (let n = 1; n < events.length; n++) {
      run = events[n].t - events[n - 1].t === 1 ? run + 1 : 0;
      worst = Math.max(worst, run);
    }
    assert.ok(worst < 24, `a run of ${worst} events a second apart`);
  }
});

test('structures stand where the map draws them', () => {
  // Blue is bottom-left: its top lane runs up the left edge and its bot lane along the
  // bottom. Red's top lane runs along the top edge, its bot lane down the right.
  assert.ok(structurePos('BLUE', 'TOP', 0).x < 2000 && structurePos('BLUE', 'TOP', 0).y > 9000);
  assert.ok(structurePos('BLUE', 'BOT', 0).y < 2000 && structurePos('BLUE', 'BOT', 0).x > 9000);
  assert.ok(structurePos('RED', 'TOP', 0).y > 12800 && structurePos('RED', 'TOP', 0).x < 6000);
  assert.ok(structurePos('RED', 'BOT', 0).x > 12800 && structurePos('RED', 'BOT', 0).y < 6000);
  // Outside in: each turret is closer to its own base than the last.
  for (const team of ['BLUE', 'RED']) {
    const base = STRUCTURES[team].nexus;
    for (const lane of ['TOP', 'MID', 'BOT']) {
      const d = [0, 1, 2, 3].map((i) => Math.hypot(structurePos(team, lane, i).x - base.x, structurePos(team, lane, i).y - base.y));
      for (let i = 1; i < d.length; i++) assert.ok(d[i] < d[i - 1], `${team} ${lane} ${i} walks away from base`);
    }
  }
});

test('a 1.0.0 result still replays', () => {
  // The shape every finished duel before 1.1.0 is stored in: no payload lane, no
  // respawn time, lanes only in the words.
  const old = {
    simVersion: '1.0.0',
    winner: 'BLUE',
    gameLength: 600,
    events: [
      { t: 0, seq: 0, type: 'GAME_START', narration: 'x' },
      { t: 100, seq: 1, type: 'KILL', team: 'BLUE', actors: { killer: 'B1', victim: 'R1', assists: [] }, pos: { x: 1, y: 1 }, narration: 'Zeus kills Bin.' },
      { t: 200, seq: 2, type: 'TOWER', team: 'BLUE', pos: { x: 1, y: 1 }, payload: { remaining: 2 }, narration: 'BLUE brings down the outer turret in TOP.' },
      { t: 300, seq: 3, type: 'INHIBITOR', team: 'RED', pos: { x: 1, y: 1 }, narration: 'RED takes the BOT inhibitor.' },
    ],
    boxScore: [
      { pid: 'B1', team: 'BLUE', slot: 'TOP', effRating: 80, kills: 1, deaths: 0, assists: 0 },
      { pid: 'R1', team: 'RED', slot: 'TOP', effRating: 78, kills: 0, deaths: 1, assists: 0 },
    ],
    timeline: [{ t: 0, goldDiff: 0, structures: { blue: 11, red: 11 } }],
    composition: { blue: { modifier: 1 }, red: { modifier: 1 } },
  };
  const s = structuresAt(old, 600);
  assert.equal(s.RED.TOP.towers, 2);
  assert.equal(s.BLUE.BOT.inhibitor, false);
  const at = positionsAt(buildTracks(old, old.boxScore), 110);
  assert.equal(at.find((p) => p.pid === 'R1').alive, false);
  const p = winChance(winPriors(old), old.timeline[0]);
  assert.ok(p > 0 && p < 1);
});

test('the engine says which version made a result', () => {
  assert.equal(match().simVersion, SIM_VERSION);
  assert.notEqual(SIM_VERSION, '1.0.0');
});

test('grades follow the result without ignoring the player', () => {
  const tally = { W: { top: 0, bottom: 0, n: 0 }, L: { top: 0, bottom: 0, n: 0 } };
  for (let i = 0; i < 300; i++) {
    const result = match(`grades-${i}`);
    for (const row of result.boxScore) {
      const t = tally[row.team === result.winner ? 'W' : 'L'];
      t.n += 1;
      if (row.grade === 'S+' || row.grade === 'S') t.top += 1;
      if (row.grade === 'D') t.bottom += 1;
    }
  }
  assert.ok(tally.W.top / tally.W.n > 2 * (tally.L.top / tally.L.n), 'winners should take more S grades');
  assert.ok(tally.L.bottom / tally.L.n > 2 * (tally.W.bottom / tally.W.n), 'losers should take more Ds');
  assert.ok(tally.L.top > 0, 'a loser can still play well enough for an S');
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
