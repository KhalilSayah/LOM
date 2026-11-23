import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effRating } from '../../packages/core/src/index.js';
import {
  ROLES, matchRatingFor, assignChampions, bestLineup, banRisk, readSwap, nearMisses, strategyEffects,
} from '../roster.ts';

/**
 * The Team screen's numbers, checked against the engine's own formula.
 *
 *   node --test --experimental-strip-types shared/test/*.test.ts
 */

const card = (over: Record<string, any> = {}) => ({
  playerName: 'P', role: 'MID', team: 'T1', season: 2024, region: 'LCK', ovr: 80, level: 1,
  championPool: [{ champion: 'Azir', mastery: 90 }],
  ...over,
});
const empty = () => Object.fromEntries(ROLES.map((r) => [r, null])) as Record<string, any>;

test('match rating counts level and mastery exactly as effRating does', () => {
  const slots = { ...empty(), MID: card({ level: 6 }) };
  const expected = effRating({ ovr: 80, level: 6, mastery: 90, slot: 'MID' });
  assert.equal(matchRatingFor(slots).value, Math.round(expected * 10) / 10);
});

test('match rating adds chemistry on top of the effective rating', () => {
  const slots = { ...empty(), MID: card(), TOP: card({ role: 'TOP', championPool: [{ champion: 'Jax', mastery: 90 }] }) };
  const r = matchRatingFor(slots);
  assert.equal(r.byRole.MID!.chemistry, 1.5);
  assert.equal(r.byRole.MID!.total, r.byRole.MID!.rating + 1.5);
});

test('no champion is fielded twice', () => {
  const slots = {
    ...empty(),
    TOP: card({ role: 'TOP', championPool: [{ champion: 'Jayce', mastery: 95 }, { champion: 'Gnar', mastery: 80 }] }),
    MID: card({ championPool: [{ champion: 'Jayce', mastery: 90 }, { champion: 'Azir', mastery: 60 }] }),
  };
  const picks = assignChampions(slots);
  assert.notEqual(picks.TOP!.champion, picks.MID!.champion);
});

test('best five takes a core over a slightly higher solo card, and changes nothing when already best', () => {
  const owned = [
    { id: 'a', card: card({ role: 'TOP', team: 'GEN', ovr: 81, championPool: [{ champion: 'Jax', mastery: 90 }] }) },
    { id: 'b', card: card({ role: 'TOP', team: 'T1', ovr: 80, championPool: [{ champion: 'Jax', mastery: 90 }] }) },
    { id: 'c', card: card({ role: 'MID', team: 'T1' }) },
  ];
  const plan = bestLineup(owned, empty());
  assert.equal(plan.slots.TOP!.id, 'b');
  assert.deepEqual(bestLineup(owned, plan.slots).changes, []);
});

test('ban risk names the two champions a ban goes after and what is left', () => {
  const slots = { ...empty(), MID: card({ championPool: [
    { champion: 'Azir', mastery: 95 }, { champion: 'Orianna', mastery: 90 }, { champion: 'Ahri', mastery: 75 },
  ] }) };
  assert.equal(banRisk(slots).MID!.text, 'Ban Azir and Orianna and MID drops to one champion at 70+');
});

test('a swap reads its chemistry with the partner it would join', () => {
  const slots = { ...empty(), TOP: card({ role: 'TOP', playerName: 'Zeus' }) };
  const swap = readSwap(slots, 'MID', card({ playerName: 'Faker' }));
  assert.equal(swap.bonusText, 'with Zeus 2024');
  assert.equal(swap.completes, 'Makes a T1 2024 duo');
});

test('a duo with a third owned card is a near miss', () => {
  const current = { ...empty(), TOP: { id: 't', card: card({ role: 'TOP' }) }, MID: { id: 'm', card: card() } };
  const owned = [current.TOP, current.MID, { id: 'j', card: card({ role: 'JNG', playerName: 'Oner' }) }];
  const [hint] = nearMisses(current, owned);
  assert.match(hint!.text, /^1 away from a T1 2024 core of three: Oner 2024 at JNG/);
});

test('strategy effects read the preset numbers', () => {
  assert.deepEqual(strategyEffects({ EARLY: 1.08, LATE: 0.94 }), ['early game +8%', 'late game −6%']);
});
