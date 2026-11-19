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

export const ROLES = ['TOP', 'JNG', 'MID', 'BOT', 'SUP'] as const;
export type Role = (typeof ROLES)[number];

/** docs/02: chemistry can never dominate, so the per-player total is capped here. */
export const CHEMISTRY_CAP = 4.5;

/** docs/09 section 4: a champion counts towards pool depth at mastery 70 and up. */
export const DEPTH_MASTERY = 70;

export interface RosterCard {
  role?: string | null;
  team?: string | null;
  season?: number | null;
  region?: string | null;
  ovr: number;
  level?: number;
  championPool?: { champion: string; mastery: number }[];
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

/** The headline number on the screen: average OVR with level factored in, one decimal. */
export function averageRating(slots: Record<string, RosterCard | null>): number {
  const present = filled(ROLES.map((r) => slots[r]));
  if (!present.length) return 0;
  const total = present.reduce((n, c) => n + c.ovr + levelBonus(c.level), 0);
  return Math.round((total / present.length) * 10) / 10;
}
