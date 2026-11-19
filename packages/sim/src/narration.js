/**
 * The commentary, generated in the engine (docs/04 section 8).
 *
 * In the engine and not the client for two reasons: it is part of the deterministic
 * output, so golden tests diff the words as well as the numbers; and the replay, the
 * result screen and a plain text play-by-play then all say the same thing about the
 * same moment.
 *
 * docs/04 R3 is the standard every line here has to meet: a player must be able to
 * read one sentence and understand what happened. "Faker catches Chovy in the river"
 * passes. "TEAMFIGHT_END margin 0.31" does not.
 */

const pick = (rng, lines) => lines[Math.floor(rng.float() * lines.length)];

export function narrate(rng, type, ctx = {}) {
  const { killer, victim, team, objective, lane, count, margin, structure } = ctx;

  switch (type) {
    case 'GAME_START':
      return 'The nexuses are up and the minions are moving.';

    case 'FIRST_BLOOD':
      return pick(rng, [
        `First blood — ${killer} catches ${victim} out.`,
        `${killer} draws first blood on ${victim}.`,
        `${victim} dies first, and ${killer} has the opening.`,
      ]);

    case 'KILL':
      return pick(rng, [
        `${killer} kills ${victim}.`,
        `${killer} catches ${victim}.`,
        `${victim} is picked off by ${killer}.`,
        `${killer} finds ${victim} and finishes it.`,
      ]);

    case 'MULTIKILL':
      return `${killer} takes ${count} of them.`;

    case 'GANK':
      return pick(rng, [
        `${killer} collapses ${lane} lane.`,
        `${killer} arrives in ${lane} and the lane breaks.`,
      ]);

    case 'SKIRMISH':
      return margin > 0.18
        ? `${team} wins a scrap in the ${ctx.region || 'jungle'} outright.`
        : `A messy trade in the ${ctx.region || 'jungle'} goes to ${team}.`;

    case 'TEAMFIGHT_START':
      return `Both sides commit around ${ctx.region || 'mid'}.`;

    case 'TEAMFIGHT_END':
      if (Math.abs(margin) > 0.3) return `${team} wins the fight clean.`;
      if (Math.abs(margin) > 0.15) return `${team} comes out ahead of the fight.`;
      return `${team} edges a fight that could have gone either way.`;

    case 'ACE':
      return `Ace — ${team} wipes them out.`;

    case 'SETUP_WON':
      return `${team} sets up around ${objective?.toLowerCase() || 'the objective'}.`;

    case 'PLATE':
      return `${team} takes a plate in ${lane}.`;

    case 'TOWER':
      return `${team} brings down the ${structure || 'turret'} in ${lane}.`;

    case 'INHIBITOR':
      return `${team} takes the ${lane} inhibitor.`;

    case 'NEXUS_TURRET':
      return `${team} is on the nexus turrets.`;

    case 'NEXUS':
      return `${team} ends it.`;

    case 'SCUTTLE':
      return `${team} takes the scuttle.`;

    case 'DRAGON':
      return count
        ? `${team} takes dragon number ${count}.`
        : `${team} takes the dragon.`;

    case 'SOUL':
      return `${team} secures the soul.`;

    case 'ELDER':
      return `${team} has elder.`;

    case 'HERALD':
      return `${team} picks up the herald.`;

    case 'BARON':
      return pick(rng, [
        `${team} takes baron.`,
        `Baron goes to ${team}.`,
      ]);

    case 'SUDDEN_DEATH':
      return `${team} is ahead when the clock runs out.`;

    case 'GAME_END':
      return `${team} wins.`;

    default:
      return '';
  }
}
