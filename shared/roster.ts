/**
 * Roster rules: chemistry, and what the five cards cover between them.
 *
 * Straight out of docs/02-cards-and-collection.md section 2.5 and docs/09 section 6.
 * It lives in `shared/` rather than in a route because the roster screen recomputes
 * it on every swap — the whole point of the screen is seeing what a change does
 * before you commit to it, and that cannot be a round trip per tap. The server does
 * not need it at all yet; when the sim lands it will, and then this is the one
 * implementation both sides read (docs/10 wants these rules unit-tested in a rules
 * package — this is where they go until that package exists).
 *
 * Chemistry deliberately returns its reasons, not just a number. A bonus a player
 * cannot explain is a bonus they cannot build towards, and "+2.5 · T1 2024 ×3" is
 * the whole teaching mechanism of the screen.
 */

import { effRating } from '../packages/core/src/index.js';

export const ROLES = ['TOP', 'JNG', 'MID', 'BOT', 'SUP'] as const;
export type Role = (typeof ROLES)[number];

/**
 * The slot a card belongs in. A card with no role reads as MID, because that is what
 * shared/cardShape.ts toCard() renders it as — the bench and the server both go through
 * this, so a role-less card is offered in exactly the slot the server will accept it in.
 */
export const DEFAULT_ROLE: Role = 'MID';
export const slotForRole = (role: string | null | undefined): string => role || DEFAULT_ROLE;

/** docs/02: chemistry can never dominate, so the per-player total is capped here. */
export const CHEMISTRY_CAP = 4.5;

/** docs/09 section 4: a champion counts towards pool depth at mastery 70 and up. */
export const DEPTH_MASTERY = 70;

export interface PoolEntry {
  champion: string;
  key?: string | null;
  mastery: number;
  /**
   * The champion role to hand `effRating` when this card plays it in its own slot, as the
   * server reads it off the catalogue (server/utils/championRoles.ts roleForFit). Missing
   * means native, which is also what the server assumes for a champion it has no record of.
   */
  fitRole?: string | null;
}

export interface RosterCard {
  playerName?: string | null;
  role?: string | null;
  team?: string | null;
  season?: number | null;
  region?: string | null;
  ovr: number;
  level?: number;
  championPool?: PoolEntry[];
}

export interface ChemistryForCard {
  bonus: number;
  reasons: string[];
}

export interface Chemistry {
  /** Per role slot, so the screen can label each card with what it is getting. */
  byRole: Record<string, ChemistryForCard>;
  /** The average per-player bonus — the single number worth putting at the top. */
  average: number;
  /** The team/season clusters that earned a bonus, biggest first. */
  cores: { label: string; size: number; bonus: number }[];
  /** Bonuses that need all five slots filled: region, season year. */
  teamWide: string[];
}

const filled = (cards: (RosterCard | null | undefined)[]) =>
  cards.filter(Boolean) as RosterCard[];

/** docs/01 section 5: a level adds 0.4 effective rating, to a maximum of +3.6. */
export const levelBonus = (level = 1) => Math.min(3.6, 0.4 * (Math.max(1, level) - 1));

/**
 * Chemistry for a roster.
 *
 * `slots` is keyed by role so an empty slot stays visible as an empty slot. The two
 * team-wide bonuses need all five, which is intentional: a four-card roster that
 * already claims "all one region" would lose the bonus on completion, and a number
 * that goes down when you add a card teaches the wrong thing.
 */
export function chemistryFor(slots: Record<string, RosterCard | null>): Chemistry {
  const byRole: Record<string, ChemistryForCard> = {};
  for (const role of ROLES) byRole[role] = { bonus: 0, reasons: [] };

  const present = filled(ROLES.map((r) => slots[r]));
  const complete = present.length === ROLES.length;

  // Cards that shared a real team in the same season. Two is a duo, three or more is
  // a core, and docs/02 is explicit that the two do not stack.
  const clusters = new Map<string, Role[]>();
  for (const role of ROLES) {
    const card = slots[role];
    if (!card?.team || !card?.season) continue;
    const key = `${card.team}|${card.season}`;
    clusters.set(key, [...(clusters.get(key) || []), role]);
  }

  const cores: Chemistry['cores'] = [];
  for (const [key, roles] of clusters) {
    if (roles.length < 2) continue;
    const bonus = roles.length >= 3 ? 2.5 : 1.5;
    const [team, season] = key.split('|');
    const label = `${team} ${season}`;
    cores.push({ label, size: roles.length, bonus });
    for (const role of roles) {
      byRole[role].bonus += bonus;
      byRole[role].reasons.push(`${label} ×${roles.length}`);
    }
  }
  cores.sort((a, b) => b.size - a.size);

  const teamWide: string[] = [];
  const everyone = (pick: (c: RosterCard) => unknown) => {
    const first = pick(present[0]);
    return Boolean(first) && present.every((c) => pick(c) === first);
  };

  if (complete && everyone((c) => c.region)) {
    teamWide.push(`All ${present[0].region}`);
    for (const role of ROLES) {
      byRole[role].bonus += 1;
      byRole[role].reasons.push(`All ${present[0].region}`);
    }
  }

  if (complete && everyone((c) => c.season)) {
    teamWide.push(`All ${present[0].season}`);
    for (const role of ROLES) {
      byRole[role].bonus += 1;
      byRole[role].reasons.push(`All ${present[0].season}`);
    }
  }

  for (const role of ROLES) {
    byRole[role].bonus = Math.min(CHEMISTRY_CAP, Math.round(byRole[role].bonus * 10) / 10);
  }

  // Averaged over the slots that hold a card, not over five: a duo in a half-built
  // roster is getting its +1.5 each, and dividing by the empty slots would report a
  // bonus nobody is receiving.
  const earned = ROLES.filter((role) => slots[role]).map((role) => byRole[role].bonus);
  const average = earned.length
    ? Math.round((earned.reduce((n, b) => n + b, 0) / earned.length) * 10) / 10
    : 0;

  return { byRole, average, cores, teamWide };
}

export interface Coverage {
  /** Distinct champions the five can play at mastery 70+. */
  champions: number;
  /** The role contributing the fewest of them, which is where bans will hurt. */
  weakest: { role: string; champions: number } | null;
  byRole: Record<string, number>;
}

/**
 * What the roster covers between them (docs/09 section 6).
 *
 * Distinct champions, not a sum: two mid laners who both main Azir cover one champion
 * between them, and a line that said two would be flattering the roster.
 */
export function coverageFor(slots: Record<string, RosterCard | null>): Coverage {
  const all = new Set<string>();
  const byRole: Record<string, number> = {};
  let weakest: Coverage['weakest'] = null;

  for (const role of ROLES) {
    const card = slots[role];
    const deep = (card?.championPool || []).filter((p) => p.mastery >= DEPTH_MASTERY);
    byRole[role] = deep.length;
    for (const p of deep) all.add(p.champion);

    if (card && (!weakest || deep.length < weakest.champions)) {
      weakest = { role, champions: deep.length };
    }
  }

  return { champions: all.size, weakest, byRole };
}

// --- what the match actually sees ----------------------------------------------------

const round1 = (n: number) => Math.round(n * 10) / 10;

export interface ChampionOption {
  /** Null for the fallback: a champion nobody on the card has played, at mastery zero. */
  champion: string | null;
  key: string | null;
  mastery: number;
  /** effRating on this champion in this slot: OVR + level, times mastery, times role fit. */
  rating: number;
}

/**
 * Everything a card could play in a slot, best first, rated the way the engine rates it.
 *
 * This is packages/core effRating and nothing else, so the number the Team screen shows is
 * the number the sim adds chemistry to (packages/sim power.js playerPower). The list always
 * ends with a zero-mastery fallback, so a card with an empty pool still has a rating.
 */
export function championOptions(card: RosterCard, slot: string): ChampionOption[] {
  const level = card.level ?? 1;
  const out: ChampionOption[] = (card.championPool || []).map((p) => ({
    champion: p.champion,
    key: p.key ?? null,
    mastery: Number(p.mastery) || 0,
    rating: effRating({ ovr: card.ovr, level, mastery: p.mastery, championRole: p.fitRole ?? slot, slot }),
  }));
  out.sort((a, b) => b.rating - a.rating || b.mastery - a.mastery);
  out.push({ champion: null, key: null, mastery: 0, rating: effRating({ ovr: card.ovr, level, mastery: 0, slot }) });
  return out;
}

const championId = (o: ChampionOption) => (o.key || o.champion || '').toLowerCase() || null;

/**
 * Who plays what, with no champion twice.
 *
 * Each card takes its best champion. When two cards would take the same one — a mid and a
 * top who both main Jayce — the five are re-solved over each card's top few options for
 * the best total, which is what a sensible draft would do. Almost every lineup takes the
 * fast path, which matters because "use my best five" runs this many times.
 */
export function assignChampions(slots: Record<string, RosterCard | null>): Record<string, ChampionOption | null> {
  const roles = ROLES.filter((r) => slots[r]);
  const options: Record<string, ChampionOption[]> = {};
  for (const r of roles) options[r] = championOptions(slots[r]!, r);

  const out: Record<string, ChampionOption | null> = {};
  for (const r of ROLES) out[r] = null;

  const firsts = roles.map((r) => options[r]![0]!);
  const ids = firsts.map(championId).filter(Boolean);
  if (new Set(ids).size === ids.length) {
    roles.forEach((r, i) => { out[r] = firsts[i]!; });
    return out;
  }

  const DEPTH = 4;
  const used = new Set<string>();
  const pick: ChampionOption[] = [];
  let best: ChampionOption[] = firsts;
  let bestSum = -Infinity;

  const walk = (i: number, sum: number) => {
    if (i === roles.length) {
      if (sum > bestSum) { bestSum = sum; best = [...pick]; }
      return;
    }
    const all = options[roles[i]!]!;
    const list = all.length > DEPTH + 1 ? [...all.slice(0, DEPTH), all[all.length - 1]!] : all;
    for (const o of list) {
      const id = championId(o);
      if (id && used.has(id)) continue;
      if (id) used.add(id);
      pick.push(o);
      walk(i + 1, sum + o.rating);
      pick.pop();
      if (id) used.delete(id);
    }
  };
  walk(0, 0);

  roles.forEach((r, i) => { out[r] = best[i]!; });
  return out;
}

export interface PlayerRating {
  champion: string | null;
  mastery: number;
  rating: number;
  chemistry: number;
  total: number;
}

export interface MatchRating {
  /** Average of (effRating + chemistry) over the filled slots, one decimal. */
  value: number;
  /** The unrounded sum, for comparing lineups without rounding ties. */
  sum: number;
  filled: number;
  byRole: Record<string, PlayerRating | null>;
  chemistry: Chemistry;
}

/**
 * The Team screen's headline: what the match feeds into every contest for these five.
 *
 * Per player that is effRating on the champion they would play plus their chemistry bonus,
 * exactly the `effRating + chemistry` packages/sim power.js starts each player's power from.
 * Averaged over the filled slots for the same reason chemistry is: an empty slot is not a
 * player scoring zero, it is a team that cannot play yet, and the screen says so separately.
 */
export function matchRatingFor(slots: Record<string, RosterCard | null>): MatchRating {
  const chemistry = chemistryFor(slots);
  const picks = assignChampions(slots);
  const byRole: Record<string, PlayerRating | null> = {};
  let sum = 0;
  let count = 0;

  for (const role of ROLES) {
    const pick = picks[role];
    if (!slots[role] || !pick) { byRole[role] = null; continue; }
    const chem = chemistry.byRole[role]?.bonus ?? 0;
    const total = pick.rating + chem;
    byRole[role] = { champion: pick.champion, mastery: pick.mastery, rating: pick.rating, chemistry: chem, total };
    sum += total;
    count++;
  }

  return { value: count ? round1(sum / count) : 0, sum, filled: count, byRole, chemistry };
}

/** Chemistry summed over the five, which is what a swap changes for the team as a whole. */
const chemistryTotal = (chem: Chemistry) => ROLES.reduce((n, r) => n + (chem.byRole[r]?.bonus ?? 0), 0);

export interface OwnedEntry {
  id: string;
  level?: number;
  card: RosterCard;
}

export interface LineupPlan {
  slots: Record<string, OwnedEntry | null>;
  /** Match rating before and after. */
  before: number;
  after: number;
  /** The lanes that change. Empty when the five already is the best five. */
  changes: string[];
}

const slotsOf = (entries: Record<string, OwnedEntry | null>) => {
  const out: Record<string, RosterCard | null> = {};
  for (const role of ROLES) out[role] = entries[role]?.card ?? null;
  return out;
};

/**
 * The five that give the highest match rating, chemistry included.
 *
 * Exhaustive over a pruned field. For each lane it keeps the cards that are best on their
 * own, the best card from every team-season that also has a card in another lane (that is
 * where a core comes from), the best from every region and year (the team-wide bonuses),
 * and whatever is in the slot now — capped near `perLane`, so the search is about
 * perLane^5 lineups. Each is scored with the real chemistryFor against each card's best
 * champion; the leaders are then re-scored with champion de-duplication, which can only
 * lower a score, and the best of those wins. Ties go to the lineup that changes less.
 */
export function bestLineup(
  owned: OwnedEntry[],
  current: Record<string, OwnedEntry | null>,
  perLane = 8,
): LineupPlan {
  const solo = new Map<OwnedEntry, number>();
  const byLane: Record<string, OwnedEntry[]> = {};
  for (const role of ROLES) byLane[role] = [];
  for (const entry of owned) {
    const lane = slotForRole(entry.card.role);
    if (!byLane[lane]) continue;
    byLane[lane]!.push(entry);
    solo.set(entry, championOptions(entry.card, lane)[0]!.rating);
  }

  const keyOf = (c: RosterCard) => (c.team && c.season ? `${c.team}|${c.season}` : null);
  const lanesByKey = new Map<string, Set<string>>();
  for (const role of ROLES) {
    for (const e of byLane[role]!) {
      const k = keyOf(e.card);
      if (!k) continue;
      if (!lanesByKey.has(k)) lanesByKey.set(k, new Set());
      lanesByKey.get(k)!.add(role);
    }
  }

  const candidates: Record<string, OwnedEntry[]> = {};
  for (const role of ROLES) {
    const ranked = [...byLane[role]!].sort((a, b) => solo.get(b)! - solo.get(a)!);
    const keep: OwnedEntry[] = [];
    const add = (e: OwnedEntry | undefined) => { if (e && !keep.includes(e) && keep.length < perLane) keep.push(e); };

    ranked.slice(0, Math.ceil(perLane / 2)).forEach(add);
    const firstBy = (pickOf: (c: RosterCard) => unknown, ok: (e: OwnedEntry) => boolean = () => true) => {
      const seen = new Set<unknown>();
      for (const e of ranked) {
        const v = pickOf(e.card);
        if (!v || seen.has(v) || !ok(e)) continue;
        seen.add(v);
        add(e);
      }
    };
    firstBy(keyOf, (e) => (lanesByKey.get(keyOf(e.card)!)?.size ?? 0) > 1);
    firstBy((c) => c.region);
    firstBy((c) => c.season);
    ranked.forEach(add);

    // The card in the slot now is always a candidate, so the plan can never be worse.
    const held = byLane[role]!.find((e) => e.id === current[role]?.id);
    if (held && !keep.includes(held)) keep.push(held);
    candidates[role] = keep;
  }

  const LEADERS = 12;
  const leaders: { score: number; pick: (OwnedEntry | null)[] }[] = [];
  const pick: (OwnedEntry | null)[] = [];
  const cards: Record<string, RosterCard | null> = {};
  for (const role of ROLES) cards[role] = null;

  const walk = (i: number, soloSum: number) => {
    if (i === ROLES.length) {
      const score = soloSum + chemistryTotal(chemistryFor(cards));
      if (leaders.length < LEADERS || score > leaders[leaders.length - 1]!.score) {
        leaders.push({ score, pick: [...pick] });
        leaders.sort((a, b) => b.score - a.score);
        if (leaders.length > LEADERS) leaders.pop();
      }
      return;
    }
    const lane = ROLES[i]!;
    // A lane you own nothing for keeps what it has, which can only be nothing.
    const list: (OwnedEntry | null)[] = candidates[lane]!.length ? candidates[lane]! : [current[lane] ?? null];
    for (const e of list) {
      pick.push(e);
      cards[lane] = e?.card ?? null;
      walk(i + 1, soloSum + (e ? solo.get(e) ?? 0 : 0));
      pick.pop();
    }
    cards[lane] = null;
  };
  walk(0, 0);

  const changesOf = (entries: Record<string, OwnedEntry | null>) =>
    ROLES.filter((r) => entries[r] && entries[r]!.id !== current[r]?.id);

  const now = matchRatingFor(slotsOf(current));
  let best = now;
  let bestSlots: Record<string, OwnedEntry | null> = { ...current };

  for (const leader of leaders) {
    const entries: Record<string, OwnedEntry | null> = {};
    ROLES.forEach((lane, i) => { entries[lane] = leader.pick[i] ?? null; });
    const rating = matchRatingFor(slotsOf(entries));
    // More lanes filled always wins: a full team can play, a better-looking four cannot.
    const better = rating.filled > best.filled
      || (rating.filled === best.filled && (rating.sum > best.sum + 1e-9
        || (Math.abs(rating.sum - best.sum) <= 1e-9 && changesOf(entries).length < changesOf(bestSlots).length)));
    if (better) { best = rating; bestSlots = entries; }
  }

  return { slots: bestSlots, before: now.value, after: best.value, changes: changesOf(bestSlots) };
}

// --- reading a single swap -------------------------------------------------------------

export interface SwapReadout {
  /** Changes to the three headline numbers. */
  matchRating: number;
  chemistry: number;
  pool: number;
  /** This card's own chemistry in that slot, and why: "with Faker 2024 · All LCK". */
  bonus: number;
  bonusText: string;
  /** The chemistry the whole five gains or loses, summed over the players. */
  teamChemistry: number;
  /** A milestone the swap reaches, if any: "Completes a T1 2024 core of three". */
  completes: string | null;
}

/** What putting `card` in `role` would change, against the five as they stand. */
export function readSwap(slots: Record<string, RosterCard | null>, role: string, card: RosterCard): SwapReadout {
  const next = { ...slots, [role]: card };
  const before = matchRatingFor(slots);
  const after = matchRatingFor(next);

  const parts: string[] = [];
  let completes: string | null = null;

  if (card.team && card.season) {
    const same = (c: RosterCard | null | undefined) => c?.team === card.team && c?.season === card.season;
    const partners = ROLES.filter((r) => r !== role && same(next[r]));
    const label = `${card.team} ${card.season}`;
    if (partners.length === 1) parts.push(`with ${next[partners[0]!]!.playerName || card.team} ${card.season}`);
    else if (partners.length > 1) parts.push(`${label} ×${partners.length + 1}`);

    const sizeBefore = ROLES.filter((r) => same(slots[r])).length;
    const sizeAfter = partners.length + 1;
    if (sizeAfter === 3 && sizeBefore < 3) completes = `Completes a ${label} core of three`;
    else if (sizeAfter === 2 && sizeBefore < 2) completes = `Makes a ${label} duo`;
  }

  for (const line of after.chemistry.teamWide) {
    parts.push(line);
    if (!before.chemistry.teamWide.includes(line)) completes = `Completes ${line}`;
  }

  return {
    matchRating: round1(after.value - before.value),
    chemistry: round1(after.chemistry.average - before.chemistry.average),
    pool: coverageFor(next).champions - coverageFor(slots).champions,
    bonus: after.chemistry.byRole[role]?.bonus ?? 0,
    bonusText: parts.join(' · '),
    teamChemistry: round1(chemistryTotal(after.chemistry) - chemistryTotal(before.chemistry)),
    completes,
  };
}

export interface NearMiss {
  text: string;
  role: string;
  /** The owned card that closes it, or null when you own nothing that would. */
  entry: OwnedEntry | null;
  /** Match rating change if you make that swap. Can be negative: chemistry is a trade. */
  delta: number | null;
}

/**
 * Chemistry you are one card away from.
 *
 * Two kinds, because they are the two the rules reward: a duo that one more card turns into
 * a core of three, and a five where four share a region or a year. Each names the card you
 * own that would close it and what the swap does to the match rating, including when that
 * is a loss — the trade is the decision, and hiding the cost would make it for you.
 */
export function nearMisses(
  current: Record<string, OwnedEntry | null>,
  owned: OwnedEntry[],
  limit = 3,
): NearMiss[] {
  const slots = slotsOf(current);
  const base = matchRatingFor(slots).value;
  const filledRoles = ROLES.filter((r) => slots[r]);
  const inFive = new Set(ROLES.map((r) => current[r]?.id).filter(Boolean));
  // Goals keyed by the card that reaches them, so one card closing two gaps reads as one line.
  const goals: { goal: string; role: string; entry: OwnedEntry | null; delta: number | null }[] = [];

  const bestFor = (role: string, ok: (c: RosterCard) => boolean) => {
    let best: { entry: OwnedEntry; delta: number } | null = null;
    for (const entry of owned) {
      if (inFive.has(entry.id) || slotForRole(entry.card.role) !== role || !ok(entry.card)) continue;
      const delta = round1(matchRatingFor({ ...slots, [role]: entry.card }).value - base);
      if (!best || delta > best.delta) best = { entry, delta };
    }
    return best;
  };

  const name = (c: RosterCard) => `${c.playerName ?? 'A card'}${c.season ? ` ${c.season}` : ''}`;

  // A duo that one more card turns into a core of three.
  const clusters = new Map<string, string[]>();
  for (const role of filledRoles) {
    const c = slots[role]!;
    if (!c.team || !c.season) continue;
    const k = `${c.team}|${c.season}`;
    clusters.set(k, [...(clusters.get(k) || []), role]);
  }
  for (const [k, roles] of clusters) {
    if (roles.length !== 2) continue;
    const [team, season] = k.split('|');
    let best: { entry: OwnedEntry; delta: number; role: string } | null = null;
    for (const role of ROLES) {
      if (roles.includes(role)) continue;
      const hit = bestFor(role, (c) => c.team === team && String(c.season) === season);
      if (hit && (!best || hit.delta > best.delta)) best = { ...hit, role };
    }
    if (best) goals.push({ goal: `a ${team} ${season} core of three`, ...best });
  }

  // Four of the five sharing a region or a year.
  if (filledRoles.length >= 4) {
    const shared: ((c: RosterCard) => unknown)[] = [(c) => c.region, (c) => c.season];
    for (const pickOf of shared) {
      const tally = new Map<unknown, number>();
      for (const role of filledRoles) {
        const v = pickOf(slots[role]!);
        if (v) tally.set(v, (tally.get(v) || 0) + 1);
      }
      for (const [value, count] of tally) {
        if (count !== 4) continue;
        const odd = ROLES.find((r) => !slots[r] || pickOf(slots[r]!) !== value)!;
        const hit = bestFor(odd, (c) => pickOf(c) === value);
        goals.push(hit
          ? { goal: `All ${value}`, role: odd, entry: hit.entry, delta: hit.delta }
          : { goal: `All ${value}`, role: odd, entry: null, delta: null });
      }
    }
  }

  const out: NearMiss[] = [];
  for (const g of goals) {
    const same = g.entry && out.find((o) => o.entry?.id === g.entry!.id);
    if (same) { same.text = same.text.replace(/: /, ` and ${g.goal}: `); continue; }
    out.push({
      text: g.entry
        ? `1 away from ${g.goal}: ${name(g.entry.card)} at ${g.role}`
        : `1 away from ${g.goal}, but you own no ${g.goal.replace(/^All /, '')} ${g.role} yet`,
      role: g.role, entry: g.entry, delta: g.delta,
    });
  }

  return out
    .sort((a, b) => (b.delta ?? -Infinity) - (a.delta ?? -Infinity))
    .slice(0, limit);
}

export interface BanRisk {
  role: string;
  /** Distinct champions at mastery 70+. */
  deep: number;
  level: 'High' | 'Medium' | 'Low';
  text: string;
}

/**
 * How exposed each lane is to bans. Names the two champions a ban would go after first —
 * the ones the card is rated highest on, which is how the draft bot picks its targets
 * (server/utils/duel.ts autoBan) — and says what is left at mastery 70+ once they are gone.
 */
export function banRisk(slots: Record<string, RosterCard | null>): Record<string, BanRisk | null> {
  const out: Record<string, BanRisk | null> = {};
  for (const role of ROLES) {
    const card = slots[role];
    if (!card) { out[role] = null; continue; }
    const seen = new Set<string>();
    const deep = championOptions(card, role).filter((o) => {
      if (!o.champion || o.mastery < DEPTH_MASTERY) return false;
      const id = o.champion.toLowerCase();
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const names = deep.slice(0, 2).map((o) => o.champion!);
    const left = deep.length - names.length;
    const leftText = left === 0 ? 'has no champion' : left === 1 ? 'drops to one champion' : `still has ${left}`;

    out[role] = {
      role,
      deep: deep.length,
      level: left === 0 ? 'High' : left === 1 ? 'Medium' : 'Low',
      text: deep.length === 0
        ? `${role} has no champion at ${DEPTH_MASTERY}+, so every draft puts them on a stretch`
        : `Ban ${names.join(' and ')} and ${role} ${leftText} at ${DEPTH_MASTERY}+`,
    };
  }
  return out;
}

// --- strategy ---------------------------------------------------------------------------

/**
 * The team-wide presets (docs/01). Their numbers live in packages/sim/src/balance.js
 * BALANCE.strategy and are read from there by strategyEffects, so a balance pass changes
 * what the picker says without touching this list. This only holds what numbers cannot:
 * a name and the one-line idea.
 */
export const STRATEGIES = [
  { id: 'STANDARD', name: 'Standard', idea: 'No lean either way: the five play their own game.' },
  { id: 'AGGRESSIVE', name: 'Aggressive', idea: 'Force fights early, before the other side scales.' },
  { id: 'SCALING', name: 'Scaling', idea: 'Give up the early game to be the stronger team late.' },
] as const;

export const DEFAULT_STRATEGY = 'STANDARD';

const EFFECT_LABEL: Record<string, string> = {
  EARLY: 'early game',
  MID: 'mid game',
  LATE: 'late game',
  LANE: 'laning',
  GANK: 'ganks',
  SKIRMISH: 'skirmishes',
  TEAMFIGHT: 'teamfights',
  OBJECTIVE_SETUP: 'objective setup',
  SIEGE: 'sieges',
  SIEGE_DEFENCE: 'base defence',
};

/** A preset's modifiers as short phrases: "early game +8%", "fights break out 12% more often". */
export function strategyEffects(preset: Record<string, number> | null | undefined): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(preset || {})) {
    const pct = Math.round(Math.abs(Number(value) - 1) * 100);
    if (!pct) continue;
    if (key === 'skirmishRate') {
      out.push(`fights break out ${pct}% ${value > 1 ? 'more' : 'less'} often`);
      continue;
    }
    out.push(`${EFFECT_LABEL[key] ?? key.toLowerCase().replace(/_/g, ' ')} ${value > 1 ? '+' : '−'}${pct}%`);
  }
  return out;
}
