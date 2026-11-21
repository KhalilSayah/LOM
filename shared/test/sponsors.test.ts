import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  demandMet, demandLabel, sponsorPayout, largestCore, rollSponsorTier, pickSponsor,
  SPONSOR_PACK, type SponsorDemand, type SponsorMatch, type SignedSponsor, type SponsorTier,
} from '../sponsors.ts';

/**
 * Sponsor demands, tested one kind at a time.
 *
 * A demand is the only thing standing between a sponsor and free money, so each kind gets
 * a case that passes, a case that fails by one, and — where it matters — the degenerate
 * lineup. docs/12 is the spec.
 *
 *   node --test --experimental-strip-types shared/test/*.test.ts
 */

const starter = (over: Partial<SponsorMatch['starters'][number]> = {}) => ({
  ovr: 80, rarity: 'EPIC', region: 'LEC', team: 'Team A', season: 2024, ...over,
});

const match = (over: Partial<SponsorMatch> = {}): SponsorMatch => ({
  starters: Array.from({ length: 5 }, () => starter()),
  won: true,
  kills: 20,
  gameLength: 1800,
  ...over,
});

test('REGION counts the starters from that region, and only that region', () => {
  const demand: SponsorDemand = { kind: 'REGION', region: 'LCK', min: 3 };

  const three = match({
    starters: [
      starter({ region: 'LCK' }), starter({ region: 'LCK' }), starter({ region: 'LCK' }),
      starter({ region: 'LEC' }), starter({ region: 'LCS' }),
    ],
  });
  assert.ok(demandMet(demand, three));

  const two = match({
    starters: [
      starter({ region: 'LCK' }), starter({ region: 'LCK' }),
      starter({ region: 'LEC' }), starter({ region: 'LCS' }), starter({ region: 'LPL' }),
    ],
  });
  assert.ok(!demandMet(demand, two));
});

test('REGION is case-insensitive about what the catalogue stored', () => {
  const demand: SponsorDemand = { kind: 'REGION', region: 'lck', min: 1 };
  assert.ok(demandMet(demand, match({ starters: [starter({ region: 'LCK' })] })));
});

test('CORE wants players who actually played together', () => {
  const demand: SponsorDemand = { kind: 'CORE', min: 3 };

  const core = match({
    starters: [
      starter({ team: 'T1', season: 2024 }),
      starter({ team: 'T1', season: 2024 }),
      starter({ team: 'T1', season: 2024 }),
      starter({ team: 'G2', season: 2022 }),
      starter({ team: 'FNC', season: 2019 }),
    ],
  });
  assert.equal(largestCore(core.starters), 3);
  assert.ok(demandMet(demand, core));

  // Same org, different seasons: not a core. That is the whole point of a player-season card.
  const spread = match({
    starters: [
      starter({ team: 'T1', season: 2024 }),
      starter({ team: 'T1', season: 2023 }),
      starter({ team: 'T1', season: 2022 }),
      starter({ team: 'G2', season: 2022 }),
      starter({ team: 'FNC', season: 2019 }),
    ],
  });
  assert.ok(!demandMet(demand, spread));
});

test('a starter with no team or season joins no core', () => {
  assert.equal(largestCore([starter({ team: null }), starter({ season: null })]), 0);
});

test('MAX_OVR reads the average, not the best or worst card', () => {
  const demand: SponsorDemand = { kind: 'MAX_OVR', ovr: 82 };

  assert.ok(demandMet(demand, match({
    starters: [starter({ ovr: 92 }), starter({ ovr: 78 }), starter({ ovr: 78 }), starter({ ovr: 78 }), starter({ ovr: 78 })],
  })));

  assert.ok(!demandMet(demand, match({
    starters: Array.from({ length: 5 }, () => starter({ ovr: 83 })),
  })));
});

test('MAX_RARITY caps the band of every starter', () => {
  const demand: SponsorDemand = { kind: 'MAX_RARITY', rarity: 'EPIC' };

  assert.ok(demandMet(demand, match({
    starters: [starter({ rarity: 'COMMON' }), starter({ rarity: 'RARE' }), starter({ rarity: 'EPIC' })],
  })));

  assert.ok(!demandMet(demand, match({
    starters: [starter({ rarity: 'EPIC' }), starter({ rarity: 'LEGENDARY' })],
  })));
});

test('an unreadable rarity is treated as the top band, never as a free pass', () => {
  const demand: SponsorDemand = { kind: 'MAX_RARITY', rarity: 'EPIC' };
  assert.ok(!demandMet(demand, match({ starters: [starter({ rarity: null })] })));
});

test('SEASON_RANGE is inclusive at both ends', () => {
  const demand: SponsorDemand = { kind: 'SEASON_RANGE', from: 2011, to: 2017, min: 2 };

  assert.ok(demandMet(demand, match({
    starters: [starter({ season: 2011 }), starter({ season: 2017 }), starter({ season: 2024 })],
  })));
  assert.ok(!demandMet(demand, match({
    starters: [starter({ season: 2010 }), starter({ season: 2018 }), starter({ season: 2024 })],
  })));
});

test('KILLS, WIN and FAST_WIN read the result rather than the five', () => {
  assert.ok(demandMet({ kind: 'KILLS', min: 25 }, match({ kills: 25 })));
  assert.ok(!demandMet({ kind: 'KILLS', min: 25 }, match({ kills: 24 })));

  assert.ok(demandMet({ kind: 'WIN' }, match({ won: true })));
  assert.ok(!demandMet({ kind: 'WIN' }, match({ won: false })));

  // Thirty minutes exactly counts; the engine reports seconds.
  assert.ok(demandMet({ kind: 'FAST_WIN', minutes: 30 }, match({ won: true, gameLength: 1800 })));
  assert.ok(!demandMet({ kind: 'FAST_WIN', minutes: 30 }, match({ won: true, gameLength: 1801 })));
  // A fast loss is still a loss.
  assert.ok(!demandMet({ kind: 'FAST_WIN', minutes: 30 }, match({ won: false, gameLength: 1200 })));
});

test('a lineup demand on an empty lineup fails rather than passing vacuously', () => {
  const empty = match({ starters: [] });
  assert.ok(!demandMet({ kind: 'REGION', region: 'LCK', min: 1 }, empty));
  assert.ok(!demandMet({ kind: 'MAX_OVR', ovr: 99 }, empty));
  assert.ok(!demandMet({ kind: 'MAX_RARITY', rarity: 'ICON' }, empty));
});

test('NONE always pays', () => {
  assert.ok(demandMet({ kind: 'NONE' }, match({ won: false, kills: 0 })));
  assert.equal(demandLabel({ kind: 'NONE' }), 'No conditions');
});

test('every demand kind has English', () => {
  const kinds: SponsorDemand[] = [
    { kind: 'NONE' },
    { kind: 'REGION', region: 'LCK', min: 3 },
    { kind: 'CORE', min: 3 },
    { kind: 'MAX_OVR', ovr: 82 },
    { kind: 'MAX_RARITY', rarity: 'EPIC' },
    { kind: 'SEASON_RANGE', from: 2011, to: 2017, min: 2 },
    { kind: 'KILLS', min: 25 },
    { kind: 'WIN' },
    { kind: 'FAST_WIN', minutes: 30 },
  ];
  for (const demand of kinds) {
    const label = demandLabel(demand);
    assert.ok(label.length > 3, `${demand.kind} has no label`);
    assert.ok(!label.includes('Unknown'), `${demand.kind} fell through`);
  }
});

// --- payouts ------------------------------------------------------------------

const signed = (over: Partial<SignedSponsor> = {}): SignedSponsor => ({
  key: 'VANTAGE',
  name: 'Vantage Peripherals',
  tier: 'RARE',
  slot: 0,
  basePayout: 40,
  bonusPayout: 80,
  demand: { kind: 'KILLS', min: 25 },
  ...over,
});

test('the appearance fee pays whatever happened; the bonus needs the demand', () => {
  const miss = sponsorPayout([signed()], match({ kills: 10 }));
  assert.equal(miss.credits, 40);
  assert.equal(miss.lines[0]!.met, false);
  assert.equal(miss.lines[0]!.bonus, 0);

  const hit = sponsorPayout([signed()], match({ kills: 30 }));
  assert.equal(hit.credits, 120);
  assert.equal(hit.lines[0]!.met, true);
});

test('two contracts are paid independently and reported in slot order', () => {
  const out = sponsorPayout([
    signed({ key: 'B', slot: 1, demand: { kind: 'WIN' }, basePayout: 10, bonusPayout: 90 }),
    signed({ key: 'A', slot: 0, demand: { kind: 'KILLS', min: 99 }, basePayout: 20, bonusPayout: 100 }),
  ], match({ won: true, kills: 10 }));

  assert.deepEqual(out.lines.map((l) => l.key), ['A', 'B']);
  assert.equal(out.credits, 20 + 10 + 90);
});

test('a Ghost halves sponsor money too, so it is not the way around the rate', () => {
  const out = sponsorPayout([signed()], match({ kills: 30 }), 0.5);
  assert.equal(out.credits, 60);
});

test('a withheld payout still explains the terms at zero Credits', () => {
  const out = sponsorPayout([signed()], match({ kills: 30 }), 0);
  assert.equal(out.credits, 0);
  assert.equal(out.lines[0]!.met, true);
  assert.equal(out.lines[0]!.demand, 'Take 25 kills as a team');
});

test('no contracts, no money and no lines', () => {
  const out = sponsorPayout([], match());
  assert.equal(out.credits, 0);
  assert.equal(out.lines.length, 0);
});

test('the tier roll stays inside the weighted bands', () => {
  const tiers = Object.keys(SPONSOR_PACK.weights);
  for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
    assert.ok(tiers.includes(rollSponsorTier(() => r)));
  }
  // The cheapest band is the floor: a roll of zero cannot land on an Icon.
  assert.equal(rollSponsorTier(() => 0), 'COMMON');
});

// --- the meeting --------------------------------------------------------------

const book: { key: string; tier: SponsorTier }[] = [
  { key: 'C1', tier: 'COMMON' },
  { key: 'C2', tier: 'COMMON' },
  { key: 'R1', tier: 'RARE' },
  { key: 'E1', tier: 'EPIC' },
  { key: 'I1', tier: 'ICON' },
];

test('a meeting draws from the tier it rolled', () => {
  // A roll of zero is the Common band, and the second rng call picks inside it.
  const { def, tier } = pickSponsor(book, new Set(), () => 0);
  assert.equal(tier, 'COMMON');
  assert.equal(def!.tier, 'COMMON');
});

test('a cleared tier walks down the ladder, and only then up', () => {
  // 0.995 lands in the Icon band (the weights are COMMON 46 … ICON 1 out of 100).
  const icon = pickSponsor(book, new Set(), () => 0.995);
  assert.equal(icon.tier, 'ICON');
  assert.equal(icon.def!.key, 'I1');

  // Same roll with the Icon contract held: Legendary is empty in this book, so the walk
  // continues down to Epic rather than failing or climbing.
  const held = pickSponsor(book, new Set(['I1']), () => 0.995);
  assert.equal(held.tier, 'ICON', 'the rolled tier is reported even when it had nothing');
  assert.equal(held.def!.key, 'E1');

  // And down again.
  const deeper = pickSponsor(book, new Set(['I1', 'E1']), () => 0.995);
  assert.equal(deeper.def!.key, 'R1');
});

test('a cleared bottom tier climbs instead', () => {
  // A roll of zero is Common, and both Commons are held: the only way is up.
  const { def, tier } = pickSponsor(book, new Set(['C1', 'C2']), () => 0);
  assert.equal(tier, 'COMMON');
  assert.equal(def!.key, 'R1');
});

test('a brand already held is never drawn again', () => {
  const owned = new Set(['C1']);
  for (const r of [0, 0.1, 0.3, 0.49]) {
    const { def } = pickSponsor(book, owned, () => r);
    assert.notEqual(def?.key, 'C1');
  }
});

test('a book you hold entirely hands back the tier and no contract', () => {
  const all = new Set(book.map((b) => b.key));
  const { def, tier } = pickSponsor(book, all, () => 0.5);
  assert.equal(def, null);
  assert.ok(SPONSOR_PACK.weights[tier] > 0);
});

test('an empty book cannot produce a contract', () => {
  const { def } = pickSponsor([], new Set(), () => 0.5);
  assert.equal(def, null);
});
