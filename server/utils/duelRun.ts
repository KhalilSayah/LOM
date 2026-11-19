import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DRAFT_LENGTH, SLOTS, ACTION_SECONDS, stepAt,
  type LockedAction, type Side, type Slot,
} from '~~/shared/draft';
import { chemistryFor } from '~~/shared/roster';
import { championRoles, roleForFit } from './championRoles';
import {
  snapshotLineup, ratingFor, autoPick, autoBan, deadlineFor, expiredBy,
  type Champion, type DuelCard, type Lineup,
} from './duel';
import { effRating } from '~~/packages/core/src/index.js';
import { simulate } from '~~/packages/sim/src/index.js';

/**
 * Driving a duel forward: catch up the clock, lock an action, finish the draft and simulate.
 *
 * Everything that changes a duel goes through here, including the agent's moves, so there is
 * one place where "the draft advanced" is written down and one place that can finish it.
 */

const poolCache = new Map<string, Champion[]>();

/** Every champion the pinned catalogue knows, which is the draftable pool. */
export async function draftPool(db: SupabaseClient, catalogueVersionId: string): Promise<Champion[]> {
  const hit = poolCache.get(catalogueVersionId);
  if (hit) return hit;

  const seen = new Map<string, string>();
  for (let from = 0; ; from += 1000) {
    const { data } = await db
      .from('card_champion_pool')
      .select('champion_key, champion_name, card_definitions!inner(catalogue_version_id)')
      .eq('card_definitions.catalogue_version_id', catalogueVersionId)
      .range(from, from + 999);
    if (!data?.length) break;
    for (const row of data as any[]) seen.set(row.champion_key, row.champion_name);
    if (data.length < 1000) break;
  }

  const pool = [...seen].map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name));
  poolCache.set(catalogueVersionId, pool);
  return pool;
}

export async function loadActions(db: SupabaseClient, duelId: string): Promise<LockedAction[]> {
  const { data } = await db
    .from('duel_actions')
    .select('idx, side, kind, champion_key, champion_name, slot, auto')
    .eq('duel_id', duelId)
    .order('idx');

  return (data || []).map((r: any) => ({
    idx: r.idx,
    side: r.side as Side,
    kind: r.kind,
    championKey: r.champion_key,
    championName: r.champion_name,
    slot: r.slot as Slot | null,
    auto: r.auto,
  }));
}

const sideOf = (duel: any, profileId: string): Side | null =>
  duel.blue_id === profileId ? 'BLUE' : duel.red_id === profileId ? 'RED' : null;

export { sideOf };

/**
 * Write one action and move the draft on.
 *
 * The insert is the lock. Both unique indexes on duel_actions — one champion once, one slot
 * once per side — mean a duplicate or out-of-order write is refused by Postgres rather than
 * by a check that might have read stale state, which is the only version of this that holds
 * up when two people act in the same instant.
 */
async function lock(
  db: SupabaseClient,
  duel: any,
  action: { idx: number; side: Side; kind: 'BAN' | 'PICK'; championKey: string; championName: string; slot: Slot | null; auto: boolean },
  bonus: Record<string, number>,
) {
  const { error } = await db.from('duel_actions').insert({
    duel_id: duel.id,
    idx: action.idx,
    side: action.side,
    kind: action.kind,
    champion_key: action.championKey,
    champion_name: action.championName,
    slot: action.slot,
    auto: action.auto,
  });

  // 23505 is someone else getting there first — another tab, or the clock and a click
  // landing together. The caller reloads and finds the draft already moved on.
  if (error) throw error;

  const nextTurn = action.idx + 1;
  const done = nextTurn >= DRAFT_LENGTH;

  await db.from('duels').update({
    turn: nextTurn,
    bonus,
    deadline_at: done ? null : deadlineFor(),
    updated_at: new Date().toISOString(),
  }).eq('id', duel.id);

  duel.turn = nextTurn;
  duel.bonus = bonus;
}

/**
 * Bring a duel up to date with the clock before anyone reads or writes it.
 *
 * Nothing schedules this: it runs whenever a duel is touched, which means a draft that both
 * players walked away from is only resolved when someone looks at it. That is deliberate —
 * a background job to advance drafts nobody is watching is a lot of machinery to make an
 * abandoned game finish slightly sooner.
 */
export async function catchUp(
  db: SupabaseClient,
  duel: any,
  actions: LockedAction[],
): Promise<LockedAction[]> {
  if (duel.status !== 'DRAFTING') return actions;

  const [roles, pool] = await Promise.all([
    championRoles(db, duel.catalogue_version_id),
    draftPool(db, duel.catalogue_version_id),
  ]);

  // Deterministic per duel and turn, so the agent's choice is reproducible from the record.
  let counter = 0;
  const rand = () => {
    const x = Math.sin(hash(`${duel.seed}:${duel.turn}:${counter++}`)) * 10000;
    return x - Math.floor(x);
  };

  let guard = 0;
  while (duel.turn < DRAFT_LENGTH && guard++ < DRAFT_LENGTH + 1) {
    const over = expiredBy(duel.deadline_at);
    if (!over) break;

    const step = stepAt(duel.turn)!;
    const bonus = { ...(duel.bonus || {}) } as Record<string, any>;
    const left = Number(bonus[step.side] ?? 0);

    /**
     * Bonus time is staked, not metered per poll (docs/05 section 3.3).
     *
     * When an action's own 30 seconds run out, the side's whole remaining pool is put behind
     * that one action at once and the deadline moves out by exactly that much. Whatever is
     * left over when they finally act is refunded in lock(), so a side that thinks for five
     * extra seconds pays five, not sixty.
     *
     * Metering it a poll at a time, which is what this did first, extends the deadline by the
     * remaining pool on every single poll — so the clock pushes itself out faster than it
     * drains and the turn never expires at all. The bug was invisible until a draft was left
     * to run.
     */
    if (left > 0 && !bonus.staked) {
      bonus.staked = { side: step.side, amount: left };
      bonus[step.side] = 0;
      const until = new Date(new Date(duel.deadline_at).getTime() + left * 1000).toISOString();
      await db.from('duels').update({
        bonus,
        deadline_at: until,
        updated_at: new Date().toISOString(),
      }).eq('id', duel.id);
      duel.bonus = bonus;
      duel.deadline_at = until;
      break;
    }

    // Pool spent as well as the action timer: the agent takes it (docs/05 section 4).
    bonus.staked = null;

    const blue = duel.blue_lineup as Lineup;
    const red = duel.red_lineup as Lineup;
    const mine = step.side === 'BLUE' ? blue : red;
    const theirs = step.side === 'BLUE' ? red : blue;

    const chosen = step.kind === 'PICK'
      ? autoPick(mine, theirs, actions, step.side, pool, roles, rand)
      : { ...autoBan(theirs, actions, step.side === 'BLUE' ? 'RED' : 'BLUE', pool, roles, rand), slot: null };

    await lock(db, duel, {
      idx: step.idx,
      side: step.side,
      kind: step.kind,
      championKey: chosen.championKey,
      championName: chosen.championName,
      slot: (chosen as any).slot ?? null,
      auto: true,
    }, bonus);

    actions = await loadActions(db, duel.id);
  }

  if (duel.turn >= DRAFT_LENGTH && duel.status === 'DRAFTING') {
    await finish(db, duel, actions);
  }
  return actions;
}

/** Lock a human action, after the caller has checked it is legal. */
export async function applyAction(
  db: SupabaseClient,
  duel: any,
  actions: LockedAction[],
  input: { side: Side; kind: 'BAN' | 'PICK'; championKey: string; championName: string; slot: Slot | null },
): Promise<LockedAction[]> {
  const step = stepAt(duel.turn)!;
  const bonus = { ...(duel.bonus || {}) } as Record<string, any>;

  // Hand back whatever of the staked pool went unused. Acting five seconds into bonus time
  // should cost five seconds of it, not the whole thing.
  if (bonus.staked?.side === input.side) {
    const unused = Math.max(0, Math.round((new Date(duel.deadline_at).getTime() - Date.now()) / 1000));
    bonus[input.side] = Math.min(Number(bonus.staked.amount) || 0, unused);
    bonus.staked = null;
  }

  await lock(db, duel, { idx: step.idx, ...input, auto: false }, bonus);

  const next = await loadActions(db, duel.id);
  if (duel.turn >= DRAFT_LENGTH) await finish(db, duel, next);
  return next;
}

/**
 * The draft is done: build the two teams and run the match.
 *
 * This is where everything the draft decided turns into something the engine can read. A
 * player's effective rating folds in the card's OVR, its level, that card's mastery on the
 * champion it was actually given, and the role-fit penalty if it was put somewhere the
 * champion is not played. Chemistry comes from the five cards, composition from the five
 * champions. Nothing about the result is independent of the draft.
 */
async function finish(db: SupabaseClient, duel: any, actions: LockedAction[]) {
  const roles = await championRoles(db, duel.catalogue_version_id);

  const build = (lineup: Lineup, side: Side) => {
    const picks = new Map<Slot, LockedAction>();
    for (const a of actions) {
      if (a.side === side && a.kind === 'PICK' && a.slot) picks.set(a.slot, a);
    }
    const chem = chemistryFor(
      Object.fromEntries(SLOTS.map((s) => [s, lineup[s] ? {
        ovr: lineup[s]!.ovr, level: lineup[s]!.level, season: lineup[s]!.season,
        team: lineup[s]!.team, region: lineup[s]!.region,
        championPool: Object.entries(lineup[s]!.pool)
          .map(([key, mastery]) => ({ champion: lineup[s]!.poolNames[key] ?? key, mastery })),
      } : null])) as any,
    );

    return {
      players: SLOTS.map((slot) => {
        const card = lineup[slot];
        const pick = picks.get(slot);
        const championKey = pick?.championKey ?? '';
        return {
          cardKey: card?.cardKey ?? `${side}-${slot}`,
          name: card?.name ?? slot,
          slot,
          champion: pick?.championName ?? 'Unknown',
          effRating: ratingFor(card, championKey, slot, roles),
          chemistry: chem.byRole?.[slot]?.bonus ?? 0,
          subStats: card?.subStats ?? {},
        };
      }),
    };
  };

  const result = simulate({
    seed: duel.seed,
    blue: build(duel.blue_lineup as Lineup, 'BLUE'),
    red: build(duel.red_lineup as Lineup, 'RED'),
  });

  await db.from('duels').update({
    status: 'COMPLETE',
    result,
    deadline_at: null,
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', duel.id);

  duel.status = 'COMPLETE';
  duel.result = result;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
