/**
 * Teams for the harnesses.
 *
 * Two hand-written squads for reading a match, and a generator for the Monte Carlo
 * matrix in docs/04 section 9 — which needs squads that differ by a known number of
 * rating points and nothing else, so that a win rate means what the table says it
 * means.
 */

const SLOTS = ['TOP', 'JNG', 'MID', 'BOT', 'SUP'];

/**
 * A spread around the mean that sums to zero.
 *
 * Flat ratings would make the "best player dies less than the worst" row in docs/04
 * section 9 meaningless — with five identical cards there is no best player, and the
 * ratio is 1.0 whatever the engine does.
 */
const SPREAD = [6, 3, 0, -3, -6];

const stats = (laning, teamfight, mechanics, macro, vision, consistency) => ({
  laning, teamfight, mechanics, macro, vision, consistency,
});

export const TEAM_A = {
  managerId: 'manager-a',
  strategy: 'STANDARD',
  coach: null,
  players: [
    { cardKey: 'zeus-2023', name: 'Zeus', slot: 'TOP', champion: 'Jax', effRating: 86, chemistry: 2.5, subStats: stats(84, 86, 88, 78, 70, 82) },
    { cardKey: 'oner-2024', name: 'Oner', slot: 'JNG', champion: 'Vi', effRating: 83, chemistry: 2.5, subStats: stats(72, 84, 85, 86, 80, 76) },
    { cardKey: 'faker-2024', name: 'Faker', slot: 'MID', champion: 'Azir', effRating: 91, chemistry: 2.5, subStats: stats(88, 93, 92, 94, 82, 93) },
    { cardKey: 'gumayusi-2024', name: 'Gumayusi', slot: 'BOT', champion: "Kai'Sa", effRating: 88, chemistry: 2.5, subStats: stats(86, 89, 90, 80, 72, 85) },
    { cardKey: 'keria-2024', name: 'Keria', slot: 'SUP', champion: 'Renata', effRating: 92, chemistry: 2.5, subStats: stats(88, 92, 93, 90, 96, 88) },
  ],
};

export const TEAM_B = {
  managerId: 'manager-b',
  strategy: 'AGGRESSIVE',
  coach: null,
  players: [
    { cardKey: 'bin-2024', name: 'Bin', slot: 'TOP', champion: "K'Sante", effRating: 87, chemistry: 1.5, subStats: stats(86, 88, 89, 74, 68, 74) },
    { cardKey: 'xun-2024', name: 'Xun', slot: 'JNG', champion: 'Sejuani', effRating: 82, chemistry: 1.5, subStats: stats(70, 83, 80, 84, 78, 78) },
    { cardKey: 'knight-2024', name: 'Knight', slot: 'MID', champion: 'Orianna', effRating: 90, chemistry: 1.5, subStats: stats(86, 92, 91, 88, 80, 86) },
    { cardKey: 'elk-2024', name: 'Elk', slot: 'BOT', champion: 'Varus', effRating: 86, chemistry: 1.5, subStats: stats(84, 87, 86, 78, 70, 83) },
    { cardKey: 'on-2024', name: 'ON', slot: 'SUP', champion: 'Rakan', effRating: 84, chemistry: 1.5, subStats: stats(82, 85, 84, 82, 90, 80) },
  ],
};

/**
 * A squad at a given mean rating, with every other input held flat.
 *
 * Flat on purpose: the balance matrix measures what a rating difference is worth, and
 * a generator that also varied sub-stats or champions would measure something else
 * and call it the same thing.
 */
export function makeTeam(id, meanRating, opts = {}) {
  return {
    managerId: id,
    strategy: opts.strategy || 'STANDARD',
    coach: opts.coach || null,
    compModifier: opts.compModifier || null,
    players: SLOTS.map((slot, i) => ({
      cardKey: `${id}-${slot.toLowerCase()}`,
      name: `${id.toUpperCase()}-${slot}`,
      slot,
      champion: opts.champions?.[i] || null,
      effRating: meanRating + SPREAD[i],
      chemistry: opts.chemistry ?? 0,
      subStats: stats(70, 70, 70, 70, 70, opts.consistency ?? 70),
    })),
  };
}
