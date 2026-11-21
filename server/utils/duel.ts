import type { SupabaseClient } from '@supabase/supabase-js';
import { randomBytes, randomInt } from 'node:crypto';
import {
  SLOTS, ACTION_SECONDS, BONUS_SECONDS,
  takenChampions, filledSlots,
  type LockedAction, type Side, type Slot,
} from '~~/shared/draft';
import { CARD_SELECT, toCard } from '~~/shared/cardShape';
import { LOBBY_SECONDS, WATCH_SPEED, asDifficulty, type Difficulty } from '~~/shared/duelRoom';
import { roleForFit } from './championRoles';
import { effRating } from '~~/packages/core/src/index.js';
import { configureChampionData, BALANCE } from '~~/packages/sim/src/index.js';
import { compositionFor, championEntry } from '~~/packages/sim/src/champions.js';
import championTable from '~~/data/champions.json';

/**
 * A duel, end to end: snapshot the lineups, run the draft, simulate the match.
 *
 * The server is the only writer. A client sends "I pick this champion into this slot" and
 * everything else — whose turn it is, what is still available, whether the clock ran out —
 * is decided here against the action log, because the action log is the only record both
 * players can be held to.
 */

// The sim holds no asset dependency and takes its champion knowledge by injection
// (docs/04 section 2). Installing it once per process is enough, and without it the
// composition modifier is a flat 1.0 for every draft ever played.
configureChampionData((championTable as any).champions);

export interface DuelCard {
  cardKey: string;
  name: string;
  slot: Slot;
  ovr: number;
  level: number;
  rarity: string;
  season: number | null;
  team: string | null;
  region: string | null;
  subStats: Record<string, number>;
  /** championKey -> mastery, which is what decides who can actually play a pick. */
  pool: Record<string, number>;
  poolNames: Record<string, string>;
  artChampionKey: string | null;
}

export type Lineup = Record<Slot, DuelCard | null>;

/**
 * The five cards a manager brings, copied at accept.
 *
 * A copy rather than a reference on purpose. docs/05 section 1 locks lineups before the
 * draft opens, and a snapshot also means a finished duel still renders months later even if
 * the card has since been levelled, re-rated by a new catalogue, or traded away.
 */
export async function snapshotLineup(db: SupabaseClient, profileId: string): Promise<Lineup> {
  const [{ data: slots }, { data: owned }] = await Promise.all([
    db.from('roster_slots').select('role, collection_card_id').eq('profile_id', profileId),
    db.from('collection_cards')
      .select(`id, level, card_definitions ( ${CARD_SELECT} )`)
      .eq('profile_id', profileId),
  ]);

  const byId = new Map((owned || []).map((row: any) => [row.id, row]));
  const out = {} as Lineup;
  for (const slot of SLOTS) out[slot] = null;

  for (const row of slots || []) {
    const held = byId.get((row as any).collection_card_id);
    if (!held?.card_definitions) continue;
    const card = toCard(held.card_definitions as any);
    const pool: Record<string, number> = {};
    const poolNames: Record<string, string> = {};
    for (const entry of card.championPool || []) {
      pool[entry.key] = entry.mastery;
      poolNames[entry.key] = entry.champion;
    }
    out[(row as any).role as Slot] = {
      cardKey: card.cardKey,
      name: card.playerName,
      slot: (row as any).role as Slot,
      ovr: card.ovr,
      level: held.level ?? 1,
      rarity: card.rarity,
      season: card.season ?? null,
      team: card.team ?? null,
      region: card.region ?? null,
      subStats: card.subStats || {},
      pool,
      poolNames,
      artChampionKey: card.artChampionKey ?? null,
    };
  }
  return out;
}

export const lineupComplete = (lineup: Lineup) => SLOTS.every((s) => lineup[s]);

/** What a card is worth on a champion, in the slot it is being put in. */
export function ratingFor(
  card: DuelCard | null,
  championKey: string,
  slot: Slot,
  roles: Map<string, any>,
): number {
  if (!card) return 30;
  return effRating({
    ovr: card.ovr,
    level: card.level,
    mastery: card.pool[championKey] ?? 0,
    championRole: roleForFit(roles, championKey, slot),
    slot,
  });
}

// --- the auto-draft agent ----------------------------------------------------

export interface Champion { key: string; name: string }

/**
 * The knobs a difficulty turns.
 *
 * NORMAL is exactly the agent docs/05 section 4 asked for, and the numbers are the ones this
 * file always used: a couple of points of noise on a pick, a point on a ban. EASY is that
 * friend not paying attention at all — it ignores what you want, barely notices its comp, and
 * its noise is wide enough to take a card off its best champion. HARD pays attention: it
 * reads its comp harder, denies what you want, and almost never fumbles. None of them looks
 * further ahead than one pick.
 *
 * `ovrShift` moves the band the bot's five is drawn from (duelBot.ts). A hard agent drafting
 * well with a weaker five is still a soft match; the cards have to move with it.
 */
export interface AgentProfile {
  pickNoise: number;
  compWeight: number;
  flexWeight: number;
  denialWeight: number;
  banNoise: number;
  ovrShift: number;
}

export const AGENT_PROFILES: Record<Difficulty, AgentProfile> = {
  EASY: { pickNoise: 14, compWeight: 2, flexWeight: 0, denialWeight: 0, banNoise: 16, ovrShift: -3 },
  NORMAL: { pickNoise: 2, compWeight: 6, flexWeight: 2, denialWeight: 3, banNoise: 1, ovrShift: 0 },
  HARD: { pickNoise: 0.4, compWeight: 8, flexWeight: 2.5, denialWeight: 4, banNoise: 0.2, ovrShift: 2 },
};

export const agentProfile = (difficulty: unknown): AgentProfile => AGENT_PROFILES[asDifficulty(difficulty)];

/** One (champion, slot) the agent could pick, scored before any noise is added. */
export interface PickOption {
  championKey: string;
  championName: string;
  slot: Slot;
  /** effRating of the card in that slot on that champion. */
  rating: number;
  mastery: number;
  score: number;
}

/**
 * Every legal pick for a side, scored the way the agent scores them.
 *
 * Split out of autoPick so that the suggestions on the draft screen are the agent's own
 * judgement rather than a second opinion that could disagree with it. "Best for your MID"
 * is literally what the agent would do in your seat, minus the dice.
 */
export function scorePicks(
  lineup: Lineup,
  opponent: Lineup,
  actions: LockedAction[],
  side: Side,
  pool: Champion[],
  roles: Map<string, any>,
  profile: AgentProfile = AGENT_PROFILES.NORMAL,
): PickOption[] {
  const taken = takenChampions(actions);
  const filled = filledSlots(actions, side);
  const openSlots = SLOTS.filter((s) => !filled.has(s));
  const available = pool.filter((c) => !taken.has(c.key));

  // What my comp already looks like, so a pick can be scored on what it adds.
  const mine = picksSoFar(actions, side);
  const baseComp = compOf(mine);

  const out: PickOption[] = [];
  for (const champ of available) {
    // How much the opponent wants it, measured the same way I do.
    const denial = profile.denialWeight
      ? Math.max(...SLOTS.map((s) => ratingFor(opponent[s], champ.key, s, roles)))
      : 0;
    const denialRisk = Math.max(0, denial - 60) / 10;

    // Playable in more than one of my empty slots is worth something: it keeps my
    // options open and makes me harder to ban out.
    const flex = openSlots.filter((s) => (lineup[s]?.pool[champ.key] ?? 0) >= 60).length;
    const flexValue = Math.max(0, flex - 1);

    for (const slot of openSlots) {
      const rating = ratingFor(lineup[slot], champ.key, slot, roles);
      const compAfter = compOf([...mine, { slot, champion: champ.name }]);
      const compDelta = (compAfter - baseComp) * 100;

      const score = rating
        + profile.compWeight * compDelta
        + profile.flexWeight * flexValue
        - profile.denialWeight * denialRisk;
      out.push({
        championKey: champ.key,
        championName: champ.name,
        slot,
        rating,
        mastery: lineup[slot]?.pool[champ.key] ?? 0,
        score,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * docs/05 section 4: competent, not optimal.
 *
 * "It should play like a reasonable friend who is not paying full attention. If it played
 * perfectly, nobody would show up." That is a design constraint, not an excuse — the noise
 * and the single ply of lookahead are deliberate, and deepening either would make a bot that
 * beats people, which is the wrong outcome for a game about collecting cards. HARD narrows
 * the noise; it does not add lookahead.
 */
export function autoPick(
  lineup: Lineup,
  opponent: Lineup,
  actions: LockedAction[],
  side: Side,
  pool: Champion[],
  roles: Map<string, any>,
  rand: () => number,
  profile: AgentProfile = AGENT_PROFILES.NORMAL,
): { championKey: string; championName: string; slot: Slot } {
  const options = scorePicks(lineup, opponent, actions, side, pool, roles, profile);

  let best: PickOption | null = null;
  let bestScore = -Infinity;
  for (const o of options) {
    const score = o.score + rand() * profile.pickNoise;
    if (score > bestScore) { best = o; bestScore = score; }
  }

  if (best) return { championKey: best.championKey, championName: best.championName, slot: best.slot };

  const taken = takenChampions(actions);
  const filled = filledSlots(actions, side);
  const fallback = pool.find((c) => !taken.has(c.key))!;
  return { championKey: fallback.key, championName: fallback.name, slot: SLOTS.find((s) => !filled.has(s))! };
}

/** One champion a ban would take away, and from whom. */
export interface BanOption {
  championKey: string;
  championName: string;
  /** Rating points the hardest-hit card loses, against its next-best champion. */
  cost: number;
  /** The card that loses them. */
  victim: { slot: Slot; name: string } | null;
}

/**
 * Every ban, scored as what it costs the other side.
 *
 * docs/05 section 4.2: the gap between that champion and their next-best option. Scoring the
 * gap rather than the champion is what makes bans look like they were aimed at a person.
 * Banning "the strongest champion" is what a bot does; banning the one champion a particular
 * card is 40 points better on is what an opponent does.
 *
 * `opponent` is the side being banned against. On the draft screen that is the player's own
 * opponent, so "denies Faker −24" is this number read straight off.
 */
export function scoreBans(
  opponent: Lineup,
  actions: LockedAction[],
  oppSide: Side,
  pool: Champion[],
  roles: Map<string, any>,
): BanOption[] {
  const taken = takenChampions(actions);
  const oppFilled = filledSlots(actions, oppSide);
  const openSlots = SLOTS.filter((s) => !oppFilled.has(s) && opponent[s]);
  const available = pool.filter((c) => !taken.has(c.key));

  // Each open card's two best champions, so "their next best if this were gone" is a lookup
  // rather than a second pass over the whole pool for every champion. Same answer as the
  // nested loop this replaced, a hundred times fewer ratings.
  const ratings = new Map<Slot, Map<string, number>>();
  const topTwo = new Map<Slot, Array<{ key: string; r: number }>>();
  for (const slot of openSlots) {
    const bySlot = new Map<string, number>();
    let first: { key: string; r: number } | null = null;
    let second: { key: string; r: number } | null = null;
    for (const c of available) {
      const r = ratingFor(opponent[slot], c.key, slot, roles);
      bySlot.set(c.key, r);
      if (!first || r > first.r) { second = first; first = { key: c.key, r }; }
      else if (!second || r > second.r) second = { key: c.key, r };
    }
    ratings.set(slot, bySlot);
    topTwo.set(slot, [first, second].filter(Boolean) as Array<{ key: string; r: number }>);
  }

  const out: BanOption[] = [];
  for (const champ of available) {
    let worst = 0;
    let victim: BanOption['victim'] = null;
    for (const slot of openSlots) {
      const withIt = ratings.get(slot)!.get(champ.key)!;
      const [first, second] = topTwo.get(slot)!;
      const other = first && first.key !== champ.key ? first.r : second?.r ?? 30;
      const gap = withIt - Math.max(30, other);
      if (gap > worst) {
        worst = gap;
        victim = { slot, name: opponent[slot]!.name };
      }
    }
    out.push({ championKey: champ.key, championName: champ.name, cost: worst, victim });
  }
  return out.sort((a, b) => b.cost - a.cost);
}

export function autoBan(
  opponent: Lineup,
  actions: LockedAction[],
  oppSide: Side,
  pool: Champion[],
  roles: Map<string, any>,
  rand: () => number,
  profile: AgentProfile = AGENT_PROFILES.NORMAL,
): { championKey: string; championName: string } {
  const options = scoreBans(opponent, actions, oppSide, pool, roles);
  let best: BanOption | null = null;
  let bestScore = -Infinity;
  for (const o of options) {
    const score = o.cost + rand() * profile.banNoise;
    if (score > bestScore) { best = o; bestScore = score; }
  }
  if (best) return { championKey: best.championKey, championName: best.championName };
  const taken = takenChampions(actions);
  const fallback = pool.find((c) => !taken.has(c.key))!;
  return { championKey: fallback.key, championName: fallback.name };
}

const picksSoFar = (actions: LockedAction[], side: Side) =>
  actions.filter((a) => a.side === side && a.kind === 'PICK' && a.slot)
    .map((a) => ({ slot: a.slot as Slot, champion: a.championName }));

/**
 * The composition modifier of a partial draft.
 *
 * compositionFor() wants five players and judges a comp on what it is missing, so scoring a
 * half-finished draft with it would punish every early pick for the picks that have not
 * happened. Empty slots are filled with the slot's own name, which the champion table does
 * not know, and an unknown champion makes the whole thing return a flat 1.0 — so a partial
 * comp scores neutral and only a complete one moves, which is the honest reading.
 */
function compOf(picks: Array<{ slot: Slot; champion: string }>): number {
  if (picks.length < SLOTS.length) {
    const filled = new Map(picks.map((p) => [p.slot, p.champion]));
    const players = SLOTS.map((slot) => ({ slot, champion: filled.get(slot) ?? `__empty_${slot}` }));
    return compositionFor(players as any, BALANCE.comp).modifier;
  }
  return compositionFor(picks.map((p) => ({ slot: p.slot, champion: p.champion })) as any,
    BALANCE.comp).modifier;
}

/**
 * A side's composition as it stands, in the engine's own terms.
 *
 * The draft screen shows this live as picks land, because the composition modifier is the
 * one part of the draft the engine scores that a person cannot work out from a card: two
 * frontline, an engage tool, peel, AoE, mixed damage (packages/sim/src/champions.js). The
 * tags come from the same champion table the match is simulated with.
 *
 * `withModifier` is false for the opponent's side: what they have picked is public and the
 * tags can be read off the champions, but the number the engine will put on it is theirs.
 */
export interface CompositionView {
  picks: Array<{ slot: Slot; champion: string; frontline: boolean; engage: boolean; peel: boolean; aoe: boolean; damage: string }>;
  frontline: number;
  engage: boolean;
  peel: boolean;
  aoe: number;
  ad: number;
  ap: number;
  complete: boolean;
  modifier: number | null;
  factors: Array<{ name: string; value: number }> | null;
}

export function compositionView(actions: LockedAction[], side: Side, withModifier: boolean): CompositionView {
  const picks = picksSoFar(actions, side).map((p) => {
    const t = championEntry(p.champion, p.slot).tags as any;
    return {
      slot: p.slot,
      champion: p.champion,
      frontline: Boolean(t.frontline),
      engage: Boolean(t.engage),
      peel: Boolean(t.peel),
      aoe: Boolean(t.aoe),
      damage: String(t.damage || 'MIXED'),
    };
  });
  const complete = picks.length === SLOTS.length;
  const full = complete && withModifier
    ? compositionFor(picks.map((p) => ({ slot: p.slot, champion: p.champion })) as any, BALANCE.comp)
    : null;
  return {
    picks,
    frontline: picks.filter((p) => p.frontline).length,
    engage: picks.some((p) => p.engage),
    peel: picks.some((p) => p.peel),
    aoe: picks.filter((p) => p.aoe).length,
    ad: picks.filter((p) => p.damage === 'AD').length,
    ap: picks.filter((p) => p.damage === 'AP').length,
    complete,
    modifier: full ? full.modifier : null,
    factors: full ? full.factors : null,
  };
}

/**
 * The open slot a champion belongs in for this side.
 *
 * Used when the clock locks a champion the player had in hand but had not slotted. It is
 * the open slot whose card rates highest on the champion — mastery and role fit both in that
 * number — so an off-pool champion goes to the lane it is actually played in rather than to
 * "the first open slot", which is how one used to land quietly on TOP.
 */
export function slotFor(
  lineup: Lineup,
  actions: LockedAction[],
  side: Side,
  championKey: string,
  roles: Map<string, any>,
): Slot | null {
  const filled = filledSlots(actions, side);
  const open = SLOTS.filter((s) => !filled.has(s));
  if (!open.length) return null;
  let best: Slot = open[0]!;
  let top = -Infinity;
  for (const slot of open) {
    const r = ratingFor(lineup[slot], championKey, slot, roles);
    if (r > top) { top = r; best = slot; }
  }
  return best;
}

// --- seeds -------------------------------------------------------------------

/**
 * A seed nobody can know in advance.
 *
 * The seed decides the agent's every pick (duelRun.ts) and the whole match. Anyone who can
 * read it before the draft can run the draft and the match locally and know the outcome, so
 * it is crypto-random, made only on the server, and migration 0015 takes the column away
 * from clients.
 */
export const newDuelSeed = () => `duel-${randomBytes(16).toString('hex')}`;

// --- challenges ----------------------------------------------------------------

/** A pending challenge nobody has answered in this long is gone. */
export const CHALLENGE_TTL_HOURS = 24;
export const challengeCutoff = () => new Date(Date.now() - CHALLENGE_TTL_HOURS * 3600 * 1000).toISOString();

/**
 * Write off this manager's pending challenges that have sat unanswered too long.
 *
 * Lazy, like everything else about duels: run whenever somebody looks at their challenges or
 * sends one, and every read filters on the cutoff as well, so an unwritten expiry is never
 * visible. Marked CANCELLED rather than given a status of its own, because to both people a
 * challenge that expired and one that was withdrawn are the same thing — it is not going to
 * happen — and every reader of `status` already knows what CANCELLED means.
 */
export async function expireStaleChallenges(db: SupabaseClient, profileId: string): Promise<void> {
  await db.from('duels')
    .update({ status: 'CANCELLED', updated_at: new Date().toISOString() })
    .eq('status', 'PENDING')
    .lt('created_at', challengeCutoff())
    .or(`challenger_id.eq.${profileId},opponent_id.eq.${profileId}`);
}

/**
 * Accept a challenge: pin both lineups, draw sides, open the room.
 *
 * One implementation for the two ways a challenge is accepted — pressing Accept, and
 * challenging somebody who has already challenged you (challenge.post.ts), which is the same
 * intention said the other way round.
 *
 * The caller has already checked that neither person is in a live room. The update is
 * conditional on the row still being PENDING and reports whether it changed anything,
 * because a challenge withdrawn in the same instant it was accepted used to come back as
 * "DRAFTING" and send the accepting player into a room that did not exist.
 */
export async function acceptChallenge(
  db: SupabaseClient,
  duel: { id: string; challenger_id: string; opponent_id: string },
  profileId: string,
): Promise<{ duelId: string; status: 'DRAFTING'; side: Side }> {
  const [mine, theirs] = await Promise.all([
    snapshotLineup(db, profileId),
    snapshotLineup(db, duel.challenger_id),
  ]);

  if (!lineupComplete(mine)) {
    throw createError({ statusCode: 400, statusMessage: 'Fill all five roster slots before accepting.' });
  }
  if (!lineupComplete(theirs)) {
    throw createError({
      statusCode: 409,
      statusMessage: 'They no longer have a full roster. The challenge cannot start.',
    });
  }

  const { data: active } = await db
    .from('catalogue_versions').select('id').eq('is_active', true).maybeSingle();
  if (!active) throw createError({ statusCode: 503, statusMessage: 'No active catalogue.' });

  // Sides are drawn here rather than handed to whoever sent the challenge: blue has first
  // ban and first pick, red has last pick, and challenging somebody should not buy either.
  const challengerIsBlue = randomInt(2) === 0;
  const blueId = challengerIsBlue ? duel.challenger_id : profileId;
  const redId = challengerIsBlue ? profileId : duel.challenger_id;

  /**
   * A friendly opens the same room a queue match does, with the same lobby.
   *
   * The challenger is not necessarily looking at their phone when this runs, so the lobby is
   * doing less here than it does for a queue match — but it costs the accepting player
   * nothing (it is inside the first action's deadline) and it means the draft screen has one
   * shape to render rather than two. The agent covers the challenger's first actions if they
   * are away, exactly as it always did.
   */
  const startsAt = new Date(Date.now() + LOBBY_SECONDS * 1000);

  const { data: changed, error } = await db.from('duels').update({
    status: 'DRAFTING',
    source: 'CHALLENGE',
    blue_id: blueId,
    red_id: redId,
    blue_lineup: challengerIsBlue ? theirs : mine,
    red_lineup: challengerIsBlue ? mine : theirs,
    catalogue_version_id: active.id,
    // Re-drawn at accept: the seed written when the challenge was sent sat in the row for as
    // long as nobody answered, and a seed is only as secret as its longest-lived copy.
    seed: newDuelSeed(),
    turn: 0,
    bonus: { BLUE: BONUS_SECONDS, RED: BONUS_SECONDS },
    starts_at: startsAt.toISOString(),
    deadline_at: new Date(startsAt.getTime() + ACTION_SECONDS * 1000).toISOString(),
    watch_speed: WATCH_SPEED,
    accepted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })
    .eq('id', duel.id)
    .eq('status', 'PENDING')
    .gte('created_at', challengeCutoff())
    .select('id');

  if (error) throw createError({ statusCode: 500, statusMessage: error.message });
  if (!changed?.length) {
    throw createError({ statusCode: 409, statusMessage: 'That challenge was withdrawn or has expired.' });
  }

  // Neither of them is searching any more: they are in a room. A queue row left behind would
  // be paired with somebody else, and that person would draft against an empty seat.
  await db.from('duel_queue').delete().in('profile_id', [duel.challenger_id, profileId]);

  return { duelId: duel.id, status: 'DRAFTING', side: blueId === profileId ? 'BLUE' : 'RED' };
}

// --- timers ------------------------------------------------------------------

export const deadlineFor = (seconds = ACTION_SECONDS) =>
  new Date(Date.now() + seconds * 1000).toISOString();

/**
 * docs/05 section 3.3. The clock is authoritative here and nowhere else; a client renders a
 * countdown from `deadlineAt` and never decides an expiry.
 *
 * Bonus time is spent before an action is taken away: a side that is thinking has 30 seconds
 * and then eats into its 60-second pool, and only when both are gone does the agent act. The
 * draft never waits indefinitely and never cancels (docs/05 section 1) — that rule is what
 * stops one person's absence ending someone else's evening.
 */
export function expiredBy(deadlineAt: string | null): number {
  if (!deadlineAt) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(deadlineAt).getTime()) / 1000));
}
