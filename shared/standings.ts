/**
 * The table.
 *
 * Pure, because a standings table is the thing a league argues about and an argument
 * is settled by something you can read and test rather than by a SQL ORDER BY nobody
 * can see. docs/01 section 3 fixes the order:
 *
 *   points -> head-to-head -> game-time differential -> total kills -> coin flip
 *
 * Two of those need a reading before they can be code.
 *
 * **Head-to-head** is only meaningful between the managers who are actually tied, and
 * with three or more tied it has to be a mini-table rather than a pair comparison —
 * otherwise A beat B, B beat C, C beat A and the sort depends on which pair the
 * comparator happened to look at first. So ties are resolved in clusters: inside a
 * cluster, only results against other members of that cluster count.
 *
 * **Game-time differential** is specified as "sum of `opponent_game_length -
 * own_game_length` across wins, rewarding fast closes". Taken literally that is always
 * zero here: a fixture is one game, and both managers were in it for the same number
 * of minutes. The intent is unambiguous though — a win in 24 minutes says more than a
 * win in 41 — so it is read as time spent: a win subtracts the game's length and a
 * loss adds it. Closing fast and dying hard both move you up, which is the same
 * ordering the spec's sentence is reaching for.
 *
 * docs/01 section 6: Ghost fixtures do not count toward the standings. They are played,
 * they produce a replay, and they are invisible here.
 */

export const WIN_POINTS = 3;
export const LOSS_POINTS = 0;

export type FixtureStage = 'REGULAR' | 'GHOST' | 'REST';

export interface PlayedFixture {
  stage: FixtureStage;
  /** Only FINAL fixtures count; anything else has no result to count. */
  status: string;
  blueMemberId: string | null;
  redMemberId: string | null;
  /** Null when the Ghost won, or when the fixture is not final. */
  winnerMemberId: string | null;
  gameLength: number | null;
  blueKills: number | null;
  redKills: number | null;
}

export interface StandingRow {
  memberId: string;
  position: number;
  played: number;
  won: number;
  lost: number;
  points: number;
  /** Seconds. Higher is better: fast wins, long losses. */
  timeDiff: number;
  kills: number;
  /** Which tiebreak actually decided this row's position, for the expandable detail. */
  decidedBy: 'POINTS' | 'HEAD_TO_HEAD' | 'TIME' | 'KILLS' | 'COIN' | null;
}

/** A fixture that has a result two members can be scored on. */
export const counts = (f: PlayedFixture): boolean =>
  f.stage === 'REGULAR'
  && f.status === 'FINAL'
  && Boolean(f.blueMemberId && f.redMemberId && f.winnerMemberId);

/**
 * A stable pseudo-random order, seeded from the league.
 *
 * The last tiebreak has to be *something*, and it must not be insertion order: a table
 * that reshuffles two level managers every time it is drawn looks broken. Same league,
 * same members, same order, for ever.
 */
function coin(leagueId: string, memberId: string): number {
  let h = 2166136261;
  const s = `${leagueId}:${memberId}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

export function standings(
  memberIds: string[],
  fixtures: PlayedFixture[],
  leagueId = '',
): StandingRow[] {
  const base = new Map<string, StandingRow>();
  for (const memberId of memberIds) {
    base.set(memberId, {
      memberId,
      position: 0,
      played: 0,
      won: 0,
      lost: 0,
      points: 0,
      timeDiff: 0,
      kills: 0,
      decidedBy: null,
    });
  }

  /** winner -> loser -> wins, for the head-to-head cluster. */
  const beat = new Map<string, Map<string, number>>();

  for (const f of fixtures) {
    if (!counts(f)) continue;

    const blue = base.get(f.blueMemberId!);
    const red = base.get(f.redMemberId!);
    // A result involving somebody who has since left the league is not scored
    // against the members who are in it.
    if (!blue || !red) continue;

    const winner = f.winnerMemberId === blue.memberId ? blue : red;
    const loser = winner === blue ? red : blue;
    const length = f.gameLength ?? 0;

    blue.played += 1;
    red.played += 1;
    winner.won += 1;
    loser.lost += 1;
    winner.points += WIN_POINTS;
    loser.points += LOSS_POINTS;
    winner.timeDiff -= length;
    loser.timeDiff += length;
    blue.kills += f.blueKills ?? 0;
    red.kills += f.redKills ?? 0;

    const row = beat.get(winner.memberId) ?? new Map<string, number>();
    row.set(loser.memberId, (row.get(loser.memberId) ?? 0) + 1);
    beat.set(winner.memberId, row);
  }

  const rows = [...base.values()];

  /** Points won against a given set of opponents only. */
  const miniPoints = (memberId: string, cluster: Set<string>) => {
    let points = 0;
    for (const [loser, wins] of beat.get(memberId) ?? []) {
      if (cluster.has(loser)) points += wins * WIN_POINTS;
    }
    return points;
  };

  // Points first, so the clusters can be found.
  rows.sort((a, b) => b.points - a.points || coin(leagueId, a.memberId) - coin(leagueId, b.memberId));

  const out: StandingRow[] = [];
  let i = 0;

  while (i < rows.length) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1]!.points === rows[i]!.points) j++;

    const cluster = rows.slice(i, j + 1);

    if (cluster.length === 1) {
      cluster[0]!.decidedBy = 'POINTS';
    } else {
      const ids = new Set(cluster.map((r) => r.memberId));
      const h2h = new Map(cluster.map((r) => [r.memberId, miniPoints(r.memberId, ids)]));

      cluster.sort((a, b) =>
        (h2h.get(b.memberId)! - h2h.get(a.memberId)!)
        || (b.timeDiff - a.timeDiff)
        || (b.kills - a.kills)
        || (coin(leagueId, a.memberId) - coin(leagueId, b.memberId)));

      // What separated each row from the one above it inside the cluster, which is
      // the only honest answer to "why am I fourth and not third".
      cluster.forEach((row, n) => {
        if (n === 0) {
          row.decidedBy = 'POINTS';
          return;
        }
        const above = cluster[n - 1]!;
        row.decidedBy =
          h2h.get(above.memberId)! !== h2h.get(row.memberId)! ? 'HEAD_TO_HEAD'
            : above.timeDiff !== row.timeDiff ? 'TIME'
              : above.kills !== row.kills ? 'KILLS'
                : 'COIN';
      });
    }

    out.push(...cluster);
    i = j + 1;
  }

  out.forEach((row, n) => { row.position = n + 1; });
  return out;
}
