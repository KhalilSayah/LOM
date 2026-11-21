import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DRAFT_LENGTH, SLOTS, ACTION_SECONDS, stepAt, illegalBecause,
  type LockedAction, type Side, type Slot,
} from '~~/shared/draft';
import { chemistryFor } from '~~/shared/roster';
import {
  WATCH_LEAD_SECONDS, botThinkSeconds, watchSettled, timingOfRow, type RoomTiming,
} from '~~/shared/duelRoom';
import { championRoles, roleForFit } from './championRoles';
import {
  ratingFor, autoPick, autoBan, deadlineFor, expiredBy, agentProfile, slotFor,
  AGENT_PROFILES,
  type Champion, type Lineup,
} from './duel';
import { recordFixtureResult } from './leagueFixture';
import { payMatchRewards } from './rewards';
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

  // 23505 is someone else getting there first — another tab, two clients nudging the same
  // deadline, or the clock and a click landing together. Callers handle that one by name;
  // anything else is a real failure and is logged here, because the alternative is a bare
  // 500 on somebody's screen and nothing in the function log to say why.
  if (error) {
    if (error.code !== '23505') {
      console.error('[duel] lock failed', {
        duel: duel.id, idx: action.idx, side: action.side, kind: action.kind,
        champion: action.championKey, slot: action.slot, auto: action.auto,
        code: error.code, message: error.message, details: error.details,
      });
    }
    throw error;
  }

  const nextTurn = action.idx + 1;
  const done = nextTurn >= DRAFT_LENGTH;
  const nextDeadline = done ? null : deadlineFor();

  /**
   * This update is also the notification.
   *
   * Both clients are subscribed to this row, so advancing the cursor is what tells them the
   * turn moved — there is no separate broadcast to get out of step with it. `updated_at` is
   * bumped every time for the same reason: it guarantees the row changes even when nothing
   * else in it did, so the push always fires.
   *
   * `hover` is not cleared here. What the opponent sees is a broadcast between the two
   * clients (migration 0007); the column now only holds the player's own selection so the
   * clock can honour it (/api/duel/[id]/hover), and every reader checks its `turn`, so a
   * stale one is ignored rather than needing to be wiped.
   */
  const { error: advanceError } = await db.from('duels').update({
    turn: nextTurn,
    bonus,
    deadline_at: nextDeadline,
    updated_at: new Date().toISOString(),
  }).eq('id', duel.id);

  /**
   * This must not fail quietly. The action is already written; if the cursor does not move
   * with it the draft stops dead — the next attempt collides with the primary key on an idx
   * that is already taken, and both players sit looking at a turn that will not change.
   *
   * It happened: the update began writing `hover` one migration before that column existed,
   * and because nothing read the error the only symptom was a draft that would not advance.
   * It is logged as well as thrown for the same reason — that bug cost an evening precisely
   * because the failure was invisible.
   */
  if (advanceError) {
    console.error('[duel] cursor advance failed', {
      duel: duel.id, from: action.idx, to: nextTurn,
      code: advanceError.code, message: advanceError.message, details: advanceError.details,
    });
    throw advanceError;
  }

  duel.turn = nextTurn;
  duel.bonus = bonus;
  /**
   * The new deadline has to land on the in-memory row too, and not only in the database.
   *
   * It did not, and the consequence was that one expired turn could auto-draft everything
   * left. catchUp loops while the deadline is expired; after a lock the row still held the
   * deadline that had just expired, so the next iteration read it, found it expired, and
   * acted again — and again — with the side that had just been given thirty fresh seconds
   * never getting them. The database was correct the whole time, which is why it was only
   * visible in a draft somebody actually walked away from.
   *
   * With this, a lock always leaves the loop looking at a future deadline, so it stops and
   * the next side gets its clock.
   */
  duel.deadline_at = nextDeadline;
}

/**
 * The duel row as shared/duelRoom.ts wants to read it.
 *
 * The match length in it is matchEnd(result) — the last event, not `gameLength` — so the
 * room is not settled, and nobody is told the match is over, before the nexus has fallen.
 */
export const timingOf = (duel: any): RoomTiming => timingOfRow(duel);

/**
 * Close a room whose shared watch has run out, if it has.
 *
 * catchUp does this for a room somebody is in. A room both players walked away from during
 * the watch is never caught up, so it sat WATCHING for hours — offering "Rejoin" on the
 * Battle screen and missing from history. Anything that lists duels calls this on the
 * WATCHING ones it finds, which settles them the moment anyone looks.
 */
export async function settleIfWatched(db: SupabaseClient, duel: any): Promise<boolean> {
  if (duel.status !== 'WATCHING' || !watchSettled(timingOf(duel), Date.now())) return false;
  await db.from('duels').update({
    status: 'COMPLETE',
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', duel.id).eq('status', 'WATCHING');
  duel.status = 'COMPLETE';
  return true;
}

/**
 * When the agent will move, on a side it is playing on purpose.
 *
 * Only meaningful for a bot duel. A deadline is a side's thirty seconds, so the turn began
 * thirty seconds before it; the agent acts a few seconds into that rather than the instant
 * the turn opens, because an instant answer does not read as an opponent — see
 * shared/duelRoom.ts. Deterministic from the seed, so the server and both clients agree on
 * the moment without anyone being told.
 */
export function botActsAt(duel: any, turn: number): number | null {
  if (!duel.bot_side || !duel.deadline_at) return null;
  const step = stepAt(turn);
  if (!step || step.side !== duel.bot_side) return null;
  const turnStart = new Date(duel.deadline_at).getTime() - ACTION_SECONDS * 1000;
  return turnStart + botThinkSeconds(duel.seed, turn) * 1000;
}

/**
 * Bring a duel up to date with the clock before anyone reads or writes it.
 *
 * Nothing schedules this: it runs whenever a duel is touched. With polling gone that is no
 * longer "whenever somebody's screen refreshes" but "whenever a client that is sitting in
 * the room tells us a deadline has passed" — see /api/duel/[id]/nudge. A room nobody is in
 * is still only resolved when somebody next opens it, which remains deliberate: a background
 * job to advance drafts nobody is watching is a lot of machinery to make an abandoned game
 * finish slightly sooner.
 */
export async function catchUp(
  db: SupabaseClient,
  duel: any,
  actions: LockedAction[],
): Promise<LockedAction[]> {
  /**
   * The shared watch has run out: close the room.
   *
   * This is the server deciding, from the same function the client draws the screen with
   * (watchSettled), that the match is over and has been looked at. Letting the client say so
   * would mean a player who closed the tab leaves a duel that is never finished, and a
   * player who lies leaves one that finished before it was watched.
   */
  if (duel.status === 'WATCHING') {
    await settleIfWatched(db, duel);
    return actions;
  }

  if (duel.status !== 'DRAFTING') return actions;

  /**
   * The action log is the draft; `turn` is only a cursor over it. If the two ever disagree
   * — an action written and the cursor left behind — the log wins, because the log is what
   * both players can be held to and the cursor is bookkeeping.
   *
   * Without this a single failed cursor update wedges the draft permanently: every later
   * attempt collides with an idx that is already filled. With it, the next person to look
   * at the duel puts it right.
   */
  if (actions.length > duel.turn) {
    const { error } = await db.from('duels').update({
      turn: actions.length,
      deadline_at: actions.length >= DRAFT_LENGTH ? null : deadlineFor(),
      updated_at: new Date().toISOString(),
    }).eq('id', duel.id);
    if (!error) {
      duel.turn = actions.length;
      duel.deadline_at = actions.length >= DRAFT_LENGTH ? null : deadlineFor();
    }
  }

  /**
   * The agent's inputs, read only if the agent is going to act.
   *
   * Both are cached per catalogue version in module scope, so this is free on a warm process
   * — but a serverless cold start is not warm, and catchUp now runs on every resync rather
   * than on a poll, which means most calls reach this line with nothing expired and nothing
   * to decide. Loading a 172-champion pool and a role table to then do nothing is the kind of
   * cost that is invisible until it is on a bill.
   */
  let agentInputs: { roles: Awaited<ReturnType<typeof championRoles>>; pool: Champion[] } | null = null;
  const inputs = async () => {
    if (!agentInputs) {
      const [roles, pool] = await Promise.all([
        championRoles(db, duel.catalogue_version_id),
        draftPool(db, duel.catalogue_version_id),
      ]);
      agentInputs = { roles, pool };
    }
    return agentInputs;
  };

  // Deterministic per duel and turn, so the agent's choice is reproducible from the record.
  let counter = 0;
  const rand = () => {
    const x = Math.sin(hash(`${duel.seed}:${duel.turn}:${counter++}`)) * 10000;
    return x - Math.floor(x);
  };

  let guard = 0;
  while (duel.turn < DRAFT_LENGTH && guard++ < DRAFT_LENGTH + 1) {
    const step = stepAt(duel.turn)!;
    const bonus = { ...(duel.bonus || {}) } as Record<string, any>;

    /**
     * A side the agent is playing moves on its own short clock, not on the expiry.
     *
     * Without this branch a bot duel is thirty seconds of staring per action and then a
     * minute of bonus time nobody is spending — the agent would only ever act because the
     * clock ran out, which is how it behaves for an absence and is nonsense when it is the
     * opponent. It also never stakes bonus time: there is nothing to protect it from.
     */
    const botMoment = botActsAt(duel, duel.turn);
    if (botMoment !== null) {
      if (Date.now() < botMoment) break;
    } else {
      if (!expiredBy(duel.deadline_at)) break;
    }

    const left = botMoment !== null ? 0 : Number(bonus[step.side] ?? 0);

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

    const { roles, pool } = await inputs();

    /**
     * The player's own choice, if they had one in hand when the clock ran out.
     *
     * Somebody who tapped Ahri, was about to lock her and watched the timer beat them used
     * to get whatever the agent fancied instead — usually something else entirely, which
     * reads as the game overruling them. Their selection is on the row (`hover`, written by
     * /api/duel/[id]/hover for exactly this), so if it is for this step and still legal it
     * is what locks. Only for a person's side: the agent playing on purpose has no hand.
     */
    const held = botMoment === null ? heldChoice(duel, step, actions, pool, roles) : null;

    // The agent playing a side on purpose plays at the duel's difficulty; standing in for a
    // person who walked away, it always plays NORMAL — it is covering for them, not testing them.
    const profile = botMoment !== null ? agentProfile(duel.difficulty) : AGENT_PROFILES.NORMAL;

    const chosen = held ?? (step.kind === 'PICK'
      ? autoPick(mine, theirs, actions, step.side, pool, roles, rand, profile)
      : { ...autoBan(theirs, actions, step.side === 'BLUE' ? 'RED' : 'BLUE', pool, roles, rand, profile), slot: null });

    /**
     * Losing this race is normal, not an error.
     *
     * Both players' clients nudge at the same instant — not by coincidence but by
     * construction: each computes the moment from the same `deadline_at` through the same
     * clock correction, so the two requests arrive milliseconds apart. Both then decide the
     * agent should act for this turn, and both try to write idx. One wins; the other is
     * refused by the primary key.
     *
     * Letting that throw is what put "Internal Server Error" on one player's screen while
     * the draft carried on perfectly for the other, which is a confusing way to find out
     * that nothing is actually wrong. The unique indexes are doing exactly their job here —
     * they are the reason two servers cannot both auto-draft the same turn — so the right
     * response is to accept the loss, re-read what the winner wrote, and carry on round the
     * loop. `guard` bounds the iterations, so a repeated collision cannot spin.
     */
    try {
      await lock(db, duel, {
        idx: step.idx,
        side: step.side,
        kind: step.kind,
        championKey: chosen.championKey,
        championName: chosen.championName,
        slot: (chosen as any).slot ?? null,
        // A held choice is the player's pick, locked by the clock rather than chosen by the agent.
        auto: !held,
      }, bonus);
    } catch (e: any) {
      if (e?.code !== '23505') throw e;
      // Somebody else moved the draft on. Catch up to where they left it.
      const { data: fresh } = await db.from('duels').select('*').eq('id', duel.id).maybeSingle();
      if (fresh) Object.assign(duel, fresh);
      actions = await loadActions(db, duel.id);
      continue;
    }

    actions = await loadActions(db, duel.id);
  }

  if (duel.turn >= DRAFT_LENGTH && duel.status === 'DRAFTING') {
    await finish(db, duel, actions);
  }
  return actions;
}

/**
 * What the player on the clock had selected, if it is for this step and still legal.
 *
 * A pick with no slot chosen goes to the open slot whose card rates highest on it (slotFor),
 * not to the first open one.
 */
function heldChoice(
  duel: any,
  step: { idx: number; side: Side; kind: 'BAN' | 'PICK' },
  actions: LockedAction[],
  pool: Champion[],
  roles: Map<string, any>,
): { championKey: string; championName: string; slot: Slot | null } | null {
  const h = duel.hover;
  if (!h || h.turn !== step.idx || h.side !== step.side || h.kind !== step.kind || !h.championKey) return null;
  const champion = pool.find((c) => c.key === h.championKey);
  if (!champion) return null;

  const legal = (slot: Slot | null) => !illegalBecause({
    turn: step.idx,
    actions,
    side: step.side,
    kind: step.kind,
    championKey: champion.key,
    slot,
    pool: new Set([champion.key]),
  });

  if (step.kind === 'BAN') return legal(null) ? { championKey: champion.key, championName: champion.name, slot: null } : null;

  const lineup = (step.side === 'BLUE' ? duel.blue_lineup : duel.red_lineup) as Lineup;
  let slot: Slot | null = (SLOTS as string[]).includes(h.slot) ? (h.slot as Slot) : null;
  if (!slot || !legal(slot)) slot = slotFor(lineup, actions, step.side, champion.key, roles);
  if (!slot || !legal(slot)) return null;
  return { championKey: champion.key, championName: champion.name, slot };
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
      /** Frozen with the lineup at accept, so a change made mid-draft cannot reach the match. */
      strategy: (lineup as any).strategy ?? 'STANDARD',
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

  /**
   * The draft ends into the watch, not into a result.
   *
   * `watch_start_at` is the whole shared-watch mechanism: one instant, written once, from
   * which both clients compute how far into the match they are. A few seconds out so that
   * neither player's first sight of the map is halfway through the first fight, and so the
   * twentieth pick is on screen long enough to be seen.
   *
   * The result is written in the same statement, because the match is already decided and
   * pretending otherwise would mean a second place where it could fail to be. Either player
   * can read the winner out of the payload before watching it — docs/05 section 6 accepts
   * that: spoiling your own replay is your business.
   */
  const watchStart = new Date(Date.now() + WATCH_LEAD_SECONDS * 1000).toISOString();

  await db.from('duels').update({
    status: 'WATCHING',
    result,
    deadline_at: null,
    watch_start_at: watchStart,
    updated_at: new Date().toISOString(),
  }).eq('id', duel.id);

  duel.status = 'WATCHING';
  duel.result = result;
  duel.watch_start_at = watchStart;

  /**
   * If this duel was a league fixture, the table learns about it now — the match is
   * decided, and docs/01 section 8 will not have standings waiting on whether anyone
   * sat through the replay. A duel that is not a fixture finds no row and does
   * nothing; a fixture that cannot be updated logs and lets the match stand.
   */
  if (duel.source === 'LEAGUE') await recordFixtureResult(db, duel.id, result);

  /**
   * And the managers get paid (docs/01 section 5).
   *
   * After the fixture, not before: the first win of a season is decided by looking at the
   * other fixtures in the league, and this one has to be FINAL before that question has a
   * correct answer. Like the fixture write, it never throws — a payout that fails must not
   * take the finished match down with it.
   */
  await payMatchRewards(db, duel, result);
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
