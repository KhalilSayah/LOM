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
 *
 * Lines are chosen on what actually happened — how many fell on each side, whether
 * the winner was the underdog, a streak ended, a steal — rather than on the fight's
 * margin, which at this engine's scale almost never leaves the middle. The words come
 * from their own random stream (`state.say`), so a new line here can never change who
 * wins a match: it only changes which sentence describes it.
 *
 * Teams are written BLUE and RED; the screen swaps in the names. Nothing here may lean
 * on the event's text being parseable: anything a screen needs is on the event itself.
 */

import { REGION_TEXT } from './map.js';

/** One draw per narrated event, however many lines the bank has. */
const pick = (rng, lines) => lines[Math.floor(rng.float() * lines.length)];

const LANE = { TOP: 'top', MID: 'mid', BOT: 'bot' };
const OBJECTIVE = {
  DRAGON: 'the dragon',
  ELDER: 'the Elder Dragon',
  BARON: 'Baron',
  HERALD: 'the Herald',
  SCUTTLE: 'the scuttle crab',
};

/** Under this chance going in, the side that won a fight was the underdog. */
const UPSET = 0.47;

const other = (team) => (team === 'BLUE' ? 'RED' : team === 'RED' ? 'BLUE' : 'the other side');
const where = (region) => REGION_TEXT[region] || 'the river';

export function narrate(rng, type, ctx = {}) {
  const lines = bank(type, ctx);
  return lines.length ? pick(rng, lines) : '';
}

function bank(type, c) {
  const team = c.team;
  const enemy = other(team);
  const lane = LANE[c.lane] || 'mid';
  const at = where(c.region);

  switch (type) {
    case 'GAME_START':
      return [
        'The nexuses are up and the minions are moving.',
        'Minions are marching. Here we go.',
        'Welcome to the Rift. The first wave is on its way.',
      ];

    case 'FIRST_BLOOD': return firstBlood(c);
    case 'KILL': return kill(c);

    case 'MULTIKILL': {
      const k = c.killer;
      if (c.count >= 5) return [`PENTAKILL! ${k} takes all five.`, `Pentakill for ${k}! One player, five kills.`];
      if (c.count === 4) return [`Quadra kill for ${k}! One more for the penta.`, `${k} has four of them!`];
      if (c.count === 3) return [`Triple kill! ${k} is tearing through them.`, `${k} takes three!`, `Triple kill for ${k}.`];
      return [`Double kill for ${k}.`, `${k} takes two.`, `${k} picks up a double.`];
    }

    case 'ACE':
      return [
        `Ace! ${team} wipes out all five.`,
        `${team} has the ace. Nobody is left standing for ${enemy}.`,
        `Ace for ${team}, and the map is theirs for a while.`,
      ];

    case 'GANK':
      if (c.won) {
        return [
          `${c.killer} ganks the ${lane} lane.`,
          `${c.killer} shows up ${lane} side for ${c.victim}.`,
          `${c.killer} times the gank on ${c.victim} perfectly.`,
          `${c.victim} looks up and ${c.killer} is already there.`,
          ...(c.laner ? [`${c.killer} and ${c.laner} collapse on ${c.victim}.`] : []),
        ];
      }
      return [
        `${c.killer} goes for ${c.victim} in the ${lane} lane, but it was seen coming.`,
        `The gank on ${c.victim} goes wrong for ${c.killer}.`,
        `${c.victim} reads the gank from ${c.killer} and turns on it.`,
        ...(c.counter ? [`${c.killer} ganks ${lane}, but the other jungler is waiting.`] : []),
      ];

    case 'SKIRMISH': return skirmish(c, team, enemy, at);

    case 'TEAMFIGHT_START': {
      const obj = OBJECTIVE[c.objective];
      if (obj) {
        return [
          `Both teams gather at ${obj}.`,
          `${team} starts on ${obj} and ${enemy} has to answer.`,
          `${enemy} won't give up ${obj} for free. Here comes the fight.`,
          ...(c.highStakes ? [`Everything is on the line at ${obj}.`] : []),
        ];
      }
      if (c.escalated) {
        return [
          `That scrap pulls everyone in. It's a full teamfight in ${at}.`,
          `More bodies arrive and it turns into a five on five in ${at}.`,
        ];
      }
      if (c.highStakes) {
        return [
          `This could decide the game. Both teams commit in ${at}.`,
          `${team} goes all in around ${at}, with the game on the line.`,
        ];
      }
      return [
        `${team} goes in around ${at}.`,
        `Both sides commit around ${at}.`,
        `${team} forces a fight in ${at}.`,
        `The teams collide in ${at}.`,
      ];
    }

    case 'TEAMFIGHT_END': return teamfightEnd(c, team, enemy);

    case 'SETUP_WON': {
      const obj = OBJECTIVE[c.objective] || 'the objective';
      if (c.objective === 'SCUTTLE') return [`${team} moves first for the scuttle crab.`, `${team} is in the river first.`];
      return [
        `${team} sets up early for ${obj}.`,
        `${team} has the vision around ${obj}.`,
        `${team} controls the river ahead of ${obj}.`,
      ];
    }

    case 'PLATE': {
      const who = c.player || team;
      if (c.count >= 4) return [`${team} has ${c.count} plates off the ${lane} turret now.`, `${who} keeps chipping: plate number ${c.count} in ${lane}.`];
      return [
        `${who} takes a turret plate in the ${lane} lane.`,
        `${team} chips a plate off the ${lane} turret.`,
        `Another plate in ${lane} for ${team}.`,
      ];
    }

    case 'TOWER': return tower(c, team, lane);

    case 'INHIBITOR':
      if (c.count >= 3) return [`All three inhibitors are down for ${enemy}.`, `${team} takes the last inhibitor. ${enemy} has nothing left to hide behind.`];
      if (c.count === 2) return [`A second inhibitor falls. ${team} is tearing the base apart.`, `${team} takes the ${lane} inhibitor too.`];
      return [
        `${team} takes the ${lane} inhibitor. Super minions are coming.`,
        `The ${lane} inhibitor falls to ${team}.`,
        `${team} breaks into the base and takes the ${lane} inhibitor.`,
      ];

    case 'NEXUS_TURRET':
      if (c.remaining === 0) return [`Both nexus turrets are gone. The nexus is exposed.`, `${team} takes the second nexus turret. One more push ends it.`];
      return [`${team} is on the nexus turrets.`, `${team} takes the first nexus turret.`];

    case 'NEXUS':
      return [
        `${team} destroys the nexus.`,
        `The nexus falls. ${team} wins it.`,
        `GG. ${team} closes it out${c.minutes ? ` at ${c.minutes} minutes` : ''}.`,
      ];

    case 'SCUTTLE':
      return [
        `${team} takes the scuttle crab.`,
        ...(c.jungler ? [`${c.jungler} secures the scuttle for ${team}.`] : []),
      ];

    case 'DRAGON': return dragon(c, team, enemy);

    case 'SOUL':
      return [`${team} completes the dragon soul.`, `Dragon soul for ${team}. That is a permanent edge.`];

    case 'ELDER':
      if (c.stolen) return [`${c.stealer} steals the Elder Dragon!`, `Elder stolen! ${c.stealer} smites it away from ${enemy}.`];
      return [
        `${team} has Elder. Every fight now favours them.`,
        `The Elder Dragon goes to ${team}.`,
        ...(c.contested ? [`${team} wins the fight and takes Elder.`] : []),
      ];

    case 'HERALD':
      return [
        `${team} takes the Rift Herald.`,
        ...(c.jungler ? [`${c.jungler} grabs the Herald for ${team}.`] : []),
        `The Herald goes to ${team}, and a turret is about to pay for it.`,
      ];

    case 'BARON': return baron(c, team, enemy);

    case 'SUDDEN_DEATH':
      return [`Time is up. ${team} is ahead when the clock runs out.`];

    case 'GAME_END':
      return [`${team} wins.`, `${team} takes the game.`];

    default:
      return [];
  }
}

function firstBlood(c) {
  const { killer: k, victim: v } = c;
  if (c.turned) return [`${v} walks into a trap. ${k} turns the gank for first blood.`, `The gank backfires: ${k} takes first blood on ${v}.`];
  if (c.kind === 'GANK' && c.killerSlot === 'JNG') return [`${k}'s gank pays off with first blood on ${v}.`, `First blood for ${k}, who ganks ${v}.`];
  if (c.assistName && c.kind === 'GANK') return [`${c.assistName} sets it up and ${k} takes first blood on ${v}.`];
  if (!c.assistCount) return [`${k} wins the duel for first blood on ${v}.`, `First blood! ${k} kills ${v} one on one.`];
  if (c.killerSlot === 'SUP') return [`First blood to the support! ${k} gets ${v}.`];
  return [
    `First blood goes to ${k}, who catches ${v}.`,
    `${k} draws first blood on ${v}.`,
    `${v} goes down first. First blood to ${k}.`,
    `First blood! ${k} on ${v}.`,
  ];
}

function kill(c) {
  const { killer: k, victim: v } = c;
  if (c.shutdown >= 3) {
    return [
      `${k} ends ${v}'s run with a shutdown.`,
      `Shutdown! ${v} was on ${c.shutdown} kills and ${k} collects.`,
      `${k} cashes in the bounty on ${v}.`,
    ];
  }
  if (c.streak >= 5) return [`${k} is unstoppable: ${c.streak} kills without dying.`, `${k} again. That is ${c.streak} in a row.`];
  if (c.streak === 3 || c.streak === 4) return [`${k} is heating up, ${c.streak} straight kills.`, `Another one for ${k}, ${c.streak} on the trot.`];
  if (c.turned) return [`${k} punishes the gank and takes down ${v}.`, `The gank goes wrong and ${v} pays for it.`];
  if (c.kind === 'GANK') {
    return [
      `${v} has nowhere to go and ${k} takes the kill.`,
      ...(c.assistName ? [`${k} finishes ${v} with help from ${c.assistName}.`] : [`${k} takes down ${v}.`]),
    ];
  }
  if (!c.assistCount && c.kind !== 'TEAMFIGHT') return [`${k} outplays ${v} one on one.`, `${k} wins the duel with ${v}.`, `${k} takes ${v} down alone.`];
  if (c.kind === 'TEAMFIGHT') {
    return [
      `${k} gets ${v}.`,
      `${v} falls to ${k}.`,
      `${k} picks up ${v} in the chaos.`,
      `${k} cleans up ${v}.`,
      ...(c.killerSlot === 'SUP' ? [`${k}, the support, takes ${v}.`] : []),
      ...(c.assistName ? [`${c.assistName} locks down ${v} and ${k} finishes it.`] : []),
    ];
  }
  return [
    `${k} kills ${v}.`,
    `${k} catches ${v} out.`,
    `${v} is picked off by ${k}.`,
    `${k} finds ${v} and finishes it.`,
    `${v} gets caught, ${k} with the kill.`,
  ];
}

function skirmish(c, team, enemy, at) {
  const won = c.lDeaths ?? 0;
  const lost = c.wDeaths ?? 0;
  const lines = [];
  if (!won && !lost) {
    lines.push(
      `A scrap in ${at} with no kills, but ${team} pushes ${enemy} back.`,
      `Nobody dies in ${at}, and ${team} comes out of it with the better health bars.`,
    );
  } else if (!lost) {
    lines.push(
      `${team} wins the skirmish in ${at} without losing anyone.`,
      `A clean pick in ${at} for ${team}.`,
      `${team} catches ${enemy} out in ${at}.`,
    );
  } else if (won < lost) {
    lines.push(
      `${enemy} gets a pick in ${at}, but ${team} holds the ground.`,
      `${enemy} takes one in ${at}, and ${team} still pushes them out.`,
      `${team} loses a player in ${at} and keeps the area anyway.`,
    );
  } else if (won === lost) {
    lines.push(
      `An even trade in ${at}, ${won} for ${lost}.`,
      `Kills on both sides in ${at}, and ${team} keeps the space.`,
      `Blow for blow in ${at}. ${team} is the one left standing there.`,
    );
  } else {
    lines.push(
      `${team} takes the skirmish in ${at}.`,
      `${team} gets the better of a scrap in ${at}.`,
      `${team} wins the fight in ${at}, ${won} for ${lost}.`,
    );
  }
  if ((c.odds ?? 0.5) < UPSET) lines.push(`${team} wins a scrap in ${at} they had no business winning.`);
  return lines;
}

function teamfightEnd(c, team, enemy) {
  const won = c.lDeaths ?? 0;
  const lost = c.wDeaths ?? 0;
  const obj = OBJECTIVE[c.objective];
  const lines = [];

  if (c.aced) {
    lines.push(`${team} leaves nobody standing.`, `${team} wins the fight and wipes ${enemy} out.`);
  } else if (!won && !lost) {
    lines.push(`Lots of damage and no kills. ${team} walks away with the better of it.`, `Both teams back off, but ${team} holds the ground.`);
  } else if (!lost && won >= 2) {
    lines.push(`${team} wins the fight clean: ${won} kills, no losses.`, `A flawless fight for ${team}.`, `${team} takes ${won} and loses nobody.`);
  } else if (won < lost) {
    lines.push(
      `${enemy} takes more kills, ${lost} for ${won}, but ${team} is the one left holding the ground.`,
      `${team} pays ${lost} for ${won} and still drives ${enemy} back.`,
    );
  } else if (won - lost >= 3) {
    lines.push(`${team} wins it ${won} for ${lost}.`, `That fight was one-sided: ${team} trades ${lost} for ${won}.`);
  } else if (won - lost <= 1) {
    lines.push(
      `${team} edges a fight that could have gone either way.`,
      `${team} just about wins that one, ${won} for ${lost}.`,
      `A bloody trade, ${won} for ${lost}, and ${team} has the last word.`,
    );
  } else {
    lines.push(`${team} comes out ahead of the fight.`, `${team} wins the teamfight, ${won} for ${lost}.`);
  }

  if ((c.odds ?? 0.5) < UPSET) lines.push(`${team} wins a fight they were not supposed to win.`, `Against the odds, ${team} takes the fight.`);
  if (obj && !c.aced) lines.push(`${team} wins the fight at ${obj}.`);
  return lines;
}

function tower(c, team, lane) {
  const s = c.structure || 'turret';
  if (c.first) {
    return [
      `First tower of the game goes to ${team}, in the ${lane} lane.`,
      `${team} takes first tower, ${lane} side.`,
    ];
  }
  if (c.herald) {
    return [
      `${team} drops the Herald in ${lane} and the ${s} crumbles.`,
      `The Herald does its job: ${team} takes the ${lane} ${s}.`,
    ];
  }
  if (c.index === 2) {
    return [
      `${team} breaks the ${lane} inhibitor turret. The base is open.`,
      `${team} takes the last turret in ${lane} and is knocking on the inhibitor.`,
    ];
  }
  if (c.index === 1) {
    return [
      `${team} pushes on and takes the ${lane} inner turret.`,
      `The ${lane} inner turret falls to ${team}.`,
    ];
  }
  return [
    `${team} takes the ${lane} outer turret.`,
    `The ${lane} outer turret falls to ${team}.`,
    `${team} knocks down the outer turret in the ${lane} lane.`,
  ];
}

function dragon(c, team, enemy) {
  if (c.stolen) {
    return [
      `STOLEN! ${c.stealer} smites the dragon away from ${enemy}.`,
      `${c.stealer} steals the dragon right out from under ${enemy}.`,
    ];
  }
  if (c.free) return [`Nobody is left to contest it. ${team} takes the dragon.`];
  if (c.soulPoint) return [`${team} takes dragon number ${c.count} and is on soul point.`, `Soul point for ${team}: that is dragon ${c.count}.`];
  const lines = [
    `${team} takes dragon number ${c.count}.`,
    `Dragon number ${c.count} for ${team}.`,
    `${team} secures the dragon.`,
  ];
  if (c.count === 1) lines.push(`${team} gets the dragon count started.`);
  if (c.contested) lines.push(`${team} wins the fight and takes the dragon.`);
  return lines;
}

function baron(c, team, enemy) {
  if (c.stolen) {
    return [
      `BARON STEAL! ${c.stealer} takes it from ${enemy}.`,
      `${c.stealer} smites Baron away from ${enemy}!`,
    ];
  }
  if (c.free) return [`With nobody alive to stop them, ${team} takes Baron.`];
  if (c.contested) return [`${team} wins the fight and takes Baron.`, `Baron goes to ${team} after the fight.`];
  return [
    `${team} takes Baron.`,
    `Baron goes to ${team}.`,
    `${team} quietly finishes Baron.`,
  ];
}
