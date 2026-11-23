<script setup lang="ts">
import { buildTracks, positionsAt, structuresAt, scoreAt, laneOfEvent, winChance, winPriors } from '~~/packages/sim/src/replay.js';
import type { MatchSoundName } from '~/composables/useSound';

/**
 * A match, being watched.
 *
 * Deliberately has no clock of its own. The parent passes one in, and that is the whole
 * reason this is a component rather than a page: the sandbox replay drives it from a local
 * requestAnimationFrame, and a duel drives it from `watch_start_at` on the duel row — one
 * instant written once, which both players compute the same number from. Two people watching
 * the same match is not a feature you can add to a player with its own clock; it is the
 * absence of one.
 *
 * Everything on screen is a pure function of that clock: positions, structures, score,
 * ticker. Nothing accumulates, so a client that was backgrounded for ten seconds and comes
 * back is instantly correct rather than ten seconds behind, which is the other thing a
 * self-driving player cannot do.
 *
 * The one thing it can do is ask: the key moments in the result are buttons that emit
 * `seek`, and a parent that owns a movable clock (a rewatch, the sandbox) jumps there. A
 * live duel simply does not listen.
 */

const props = defineProps<{
  result: any;
  /** Match seconds. The parent owns this. */
  clock: number;
  blueName: string;
  redName: string;
  /** Which side is the viewer's, so their own team can be named as theirs. */
  mySide?: 'BLUE' | 'RED' | null;
  /** The box score and winner. Held back until the match has actually finished. */
  showResult?: boolean;
  /** Whether key moments can be jumped to. Off for a live duel, whose clock nobody moves. */
  seekable?: boolean;
  /** Lead with the verdict rather than the map: a finished duel is opened to see who won. */
  resultFirst?: boolean;
}>();

const emit = defineEmits<{ seek: [t: number] }>();

const boardEl = ref<HTMLElement | null>(null);
/** Jump to a moment, and bring the map back into view so the jump is seen. */
function seekTo(t: number) {
  emit('seek', Math.max(0, t - 4));
  boardEl.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const length = computed(() => matchEnd(props.result));

/**
 * The match makes noise as it is watched: a kill pings, a dragon or a tower sounds a horn,
 * Baron and Elder land heavy. Only events crossed by the clock moving forward a little — a
 * scrub or a jump to the end is silent, or the result screen would play the whole game at once.
 */
const SOUND_OF: Record<string, 'kill' | 'objective' | 'baron'> = {
  KILL: 'kill', FIRST_BLOOD: 'kill', GANK: 'kill', SKIRMISH: 'kill', ACE: 'kill', TEAMFIGHT_END: 'kill',
  DRAGON: 'objective', HERALD: 'objective', SOUL: 'objective', TOWER: 'objective', INHIBITOR: 'objective', NEXUS_TURRET: 'objective',
  BARON: 'baron', ELDER: 'baron', NEXUS: 'baron',
};
const RANK = { kill: 1, objective: 2, baron: 3 } as const;

// --- names ----------------------------------------------------------------------------

const nameByPid = computed(() => {
  const out: Record<string, string> = {};
  for (const r of props.result?.boxScore ?? []) out[r.pid] = r.name;
  return out;
});
const who = (pid: string | undefined) => (pid ? nameByPid.value[pid] || '' : '');
const teamName = (side: string) => {
  const n = side === 'BLUE' ? props.blueName : props.redName;
  return n === 'You' ? 'your team' : n;
};

// --- big moments --------------------------------------------------------------------

/**
 * The handful of moments a caster would shout about, each with its banner line, its sound
 * and whether a fast replay should slow down for it. Built once per result.
 *
 * A result from before sim 1.1.0 has no MULTIKILL events; for those, multikills are read off
 * the kill log instead (one player, kills no more than ten seconds apart), so an old duel
 * still gets its triple kill.
 */
type Big = { t: number; seq: number; kind: string; team: string; text: string; sound: MatchSoundName; slow: boolean; rank: number };
const MULTI_WORD: Record<number, string> = { 2: 'Double', 3: 'Triple', 4: 'Quadra', 5: 'Penta' };
const MULTI_SOUND: Record<number, MatchSoundName> = { 2: 'doubleKill', 3: 'tripleKill', 4: 'quadraKill', 5: 'pentaKill' };

function derivedMultikills(events: any[]) {
  const out: any[] = [];
  const run = new Map<string, { n: number; last: number; seq: number; team: string }>();
  for (const e of events) {
    if (e.type !== 'KILL' && e.type !== 'FIRST_BLOOD') continue;
    const killer = e.actors?.killer;
    const victim = e.actors?.victim;
    if (victim) run.delete(victim);
    if (!killer) continue;
    const r = run.get(killer);
    const next = r && e.t - r.last <= 10 ? { n: r.n + 1, last: e.t, seq: e.seq, team: e.team } : { n: 1, last: e.t, seq: e.seq, team: e.team };
    run.set(killer, next);
    if (next.n >= 2) {
      const prev = out.findIndex((m) => m.actors.killer === killer && e.t - m.t <= 10);
      if (prev >= 0) out.splice(prev, 1);
      out.push({ type: 'MULTIKILL', t: e.t + 1, seq: e.seq + 0.5, team: e.team, actors: { killer }, payload: { count: Math.min(5, next.n) } });
    }
  }
  return out;
}

const bigMoments = computed<Big[]>(() => {
  const events: any[] = props.result?.events ?? [];
  const multis = events.some((e) => e.type === 'MULTIKILL') ? [] : derivedMultikills(events);
  const out: Big[] = [];
  for (const e of [...events, ...multis]) {
    const team = e.team || '';
    const side = teamName(team);
    const base = { t: e.t, seq: e.seq ?? 0, kind: e.type, team };
    switch (e.type) {
      case 'FIRST_BLOOD':
        out.push({ ...base, text: `First blood: ${who(e.actors?.killer) || side}`, sound: 'firstBlood', slow: false, rank: 2 });
        break;
      case 'MULTIKILL': {
        const n = Math.min(5, e.payload?.count ?? 2);
        out.push({ ...base, text: `${MULTI_WORD[n]} kill: ${who(e.actors?.killer)}`, sound: MULTI_SOUND[n], slow: n >= 3, rank: 2 + n });
        break;
      }
      case 'ACE':
        out.push({ ...base, text: `Ace for ${side}`, sound: 'ace', slow: true, rank: 6 });
        break;
      case 'BARON':
        out.push(e.payload?.stolen
          ? { ...base, text: `Baron steal: ${who(e.actors?.killer)}`, sound: 'steal', slow: true, rank: 8 }
          : { ...base, text: `Baron for ${side}`, sound: 'baronTaken', slow: true, rank: 7 });
        break;
      case 'ELDER':
        out.push(e.payload?.stolen
          ? { ...base, text: `Elder steal: ${who(e.actors?.killer)}`, sound: 'steal', slow: true, rank: 8 }
          : { ...base, text: `Elder Dragon for ${side}`, sound: 'elderTaken', slow: true, rank: 7 });
        break;
      case 'DRAGON':
        if (e.payload?.stolen) out.push({ ...base, text: `Dragon steal: ${who(e.actors?.killer)}`, sound: 'steal', slow: true, rank: 6 });
        break;
      case 'SOUL':
        out.push({ ...base, text: `Dragon soul for ${side}`, sound: 'soulTaken', slow: false, rank: 5 });
        break;
      case 'NEXUS':
        out.push({ ...base, text: `${side.charAt(0).toUpperCase()}${side.slice(1)} destroys the nexus`, sound: 'nexusFall', slow: true, rank: 9 });
        break;
      default:
        break;
    }
  }
  return out.sort((a, b) => a.t - b.t || a.seq - b.seq);
});

// A ReplayTransport in the controls slot eases a fast replay down to 8x around these.
provide('matchMoments', computed(() => bigMoments.value.filter((m) => m.slow).map((m) => m.t)));

const banner = ref<Big | null>(null);
/** The polite live region's text: big moments only, never the play-by-play. */
const announce = ref('');
let bannerTimer: ReturnType<typeof setTimeout> | null = null;

function showBanner(m: Big) {
  banner.value = m;
  announce.value = m.text;
  playMatchSound(m.sound);
  if (bannerTimer) clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { banner.value = null; }, 2400);
}

/**
 * The "just happened" ring, in real time. Set when the clock moves forward over an event
 * with a position and held for 700 ms of wall clock — 3 game seconds was 50 ms at 60x, which
 * nobody could see. A paused or scrubbed clock shows the last event still instead.
 */
const liveFlash = ref<{ x: number; y: number; kind: string; at: number } | null>(null);
let flashTimer: ReturnType<typeof setTimeout> | null = null;
let lastForwardAt = 0;

watch(() => props.clock, (now, before) => {
  if (!props.result?.events || before === undefined) return;
  const step = now - before;
  if (step <= 0 || step > 40) return;
  lastForwardAt = performance.now();

  let loudest: 'kill' | 'objective' | 'baron' | null = null;
  let ring: any = null;
  for (const e of props.result.events) {
    if (e.t <= before || e.t > now) continue;
    const s = SOUND_OF[e.type];
    if (s && (!loudest || RANK[s] > RANK[loudest])) loudest = s;
    if (e.pos) ring = e;
  }

  let big: Big | null = null;
  for (const m of bigMoments.value) {
    if (m.t <= before || m.t > now) continue;
    if (!big || m.rank >= big.rank) big = m;
  }

  if (big) showBanner(big);
  else if (loudest) playSound(loudest);

  if (ring) {
    liveFlash.value = { ...ring.pos, kind: ring.type, at: performance.now() };
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { liveFlash.value = null; }, 720);
  }
});

onBeforeUnmount(() => {
  if (bannerTimer) clearTimeout(bannerTimer);
  if (flashTimer) clearTimeout(flashTimer);
});

const tracks = computed(() =>
  (props.result ? buildTracks(props.result, props.result.boxScore) : null));
const positions = computed(() => (tracks.value ? positionsAt(tracks.value, props.clock) : []));
const structures = computed(() => (props.result ? structuresAt(props.result, props.clock) : null));
const score = computed(() => (props.result ? scoreAt(props.result, props.clock) : null));

// --- the play-by-play ---------------------------------------------------------------

/** Setup lines and scuttle crabs: true, but not what anyone is watching for. */
const FILLER = new Set(['SETUP_WON', 'SCUTTLE']);
const FEED_KEY = 'lom-feed-all';
const showAll = ref(false);
onMounted(() => {
  try { showAll.value = window.localStorage.getItem(FEED_KEY) === '1'; } catch { /* default stands */ }
});
function toggleAll() {
  showAll.value = !showAll.value;
  try { window.localStorage.setItem(FEED_KEY, showAll.value ? '1' : '0'); } catch { /* fine */ }
}

/** Everything that has happened by now, newest first — the auto-scrolling ticker. */
const ticker = computed(() => {
  if (!props.result) return [];
  return props.result.events
    .filter((e: any) => e.t <= props.clock && e.narration && (showAll.value || !FILLER.has(e.type)))
    .slice(-60)
    .reverse();
});

/** The events worth a highlight in the ticker: kills of note and the big objectives. */
const LOUD = new Set(['FIRST_BLOOD', 'MULTIKILL', 'ACE', 'BARON', 'ELDER', 'SOUL', 'INHIBITOR', 'NEXUS']);

const staticRecent = computed(() => {
  if (!props.result) return null;
  const hit = [...props.result.events]
    .reverse()
    .find((e: any) => e.pos && e.t <= props.clock && props.clock - e.t < 3);
  return hit ? { ...hit.pos, kind: hit.type } : null;
});
/** Playing: the real-time ring only. Paused or scrubbed: the still one. */
const recent = computed(() => {
  if (liveFlash.value) return liveFlash.value;
  void props.clock;
  return performance.now() - lastForwardAt < 250 ? null : staticRecent.value;
});

const clockText = (t: number) =>
  `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/** The gold-diff graph: blue above the line, red below, filled so the lead reads as area. */
const graph = computed(() => {
  const samples = props.result?.timeline ?? [];
  if (samples.length < 2) return null;

  const peak = Math.max(2000, ...samples.map((s: any) => Math.abs(s.goldDiff)));
  const pts = samples.map((s: any) => ({
    x: (s.t / (length.value || 1)) * 100,
    y: 20 - (s.goldDiff / peak) * 18,
  }));
  const line = pts.map((p: any, i: number) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1].x.toFixed(2)},20 L${pts[0].x.toFixed(2)},20 Z`;

  // The win-chance line: blue's chance, read off each sample by the engine's fitted model,
  // drawn on the same even line (50% is the zero of the gold lead). The last sample is
  // after the nexus has fallen, where the model has nothing to say.
  const priors = winPriors(props.result);
  const chances = samples.slice(0, -1).map((s: any) => ({ t: s.t, p: winChance(priors, s) }));
  const win = chances.length >= 2
    ? chances.map((c: any, i: number) => `${i === 0 ? 'M' : 'L'}${((c.t / (length.value || 1)) * 100).toFixed(2)},${(20 - (c.p - 0.5) * 36).toFixed(2)}`).join(' ')
    : '';

  // Text for the graph, which is otherwise a picture.
  let best = { v: 0, t: 0 };
  let worst = { v: 0, t: 0 };
  for (const s of samples) {
    if (s.goldDiff > best.v) best = { v: s.goldDiff, t: s.t };
    if (s.goldDiff < worst.v) worst = { v: s.goldDiff, t: s.t };
  }
  const k = (v: number) => `${(Math.abs(v) / 1000).toFixed(1)}k`;
  const parts = [];
  if (best.v > 0) parts.push(`${props.blueName} led by up to ${k(best.v)} at ${clockText(best.t)}`);
  if (worst.v < 0) parts.push(`${props.redName} led by up to ${k(worst.v)} at ${clockText(worst.t)}`);
  const summary = `Gold lead over the match. ${parts.join('; ') || 'Even all game'}.`;

  return { line, area, peak, win, chances, summary };
});

/** Blue's chance at the playhead, interpolated between the minute samples. */
const liveChance = computed(() => {
  const c = graph.value?.chances ?? [];
  if (c.length < 2) return null;
  const t = props.clock;
  let i = c.findIndex((x: any) => x.t > t);
  if (i === -1) return c[c.length - 1].p;
  if (i === 0) return c[0].p;
  const a = c[i - 1];
  const b = c[i];
  return a.p + (b.p - a.p) * ((t - a.t) / (b.t - a.t || 1));
});
const chanceText = computed(() => {
  const p = liveChance.value;
  if (p == null) return '';
  const blue = p >= 0.5;
  return `${blue ? props.blueName : props.redName} ${Math.round((blue ? p : 1 - p) * 100)}%`;
});

const liveGold = computed(() => score.value?.goldDiff ?? 0);
const progress = computed(() => Math.min(100, (props.clock / (length.value || 1)) * 100));

const won = computed(() =>
  props.mySide ? props.result?.winner === props.mySide : null);

const nameOf = (side: string) => (side === 'BLUE' ? props.blueName : props.redName);

/** The engine narrates in BLUE and RED; a viewer reads team names. */
const said = (text: string) => String(text || '')
  .replace(/\bBLUE\b/g, props.blueName === 'You' ? 'Your team' : props.blueName)
  .replace(/\bRED\b/g, props.redName === 'You' ? 'Your team' : props.redName);

// --- the result ---------------------------------------------------------------------

const GRADE_RANK: Record<string, number> = { 'S+': 6, S: 5, A: 4, B: 3, C: 2, D: 1 };
const kda = (r: any) => (r.kills + r.assists) / Math.max(1, r.deaths);
const ROLE_ORDER = ['TOP', 'JNG', 'MID', 'BOT', 'SUP'];
const ROLE_NAME: Record<string, string> = { TOP: 'Top', JNG: 'Jungle', MID: 'Mid', BOT: 'Bot', SUP: 'Support' };

function bestOf(rows: any[]) {
  return [...rows].sort((a, b) =>
    (GRADE_RANK[b.grade] ?? 0) - (GRADE_RANK[a.grade] ?? 0) || kda(b) - kda(a))[0] ?? null;
}

const sides = computed(() => {
  const rows = props.result?.boxScore ?? [];
  const pick = (team: string) => rows
    .filter((r: any) => r.team === team)
    .sort((a: any, b: any) => ROLE_ORDER.indexOf(a.slot) - ROLE_ORDER.indexOf(b.slot));
  const blue = pick('BLUE');
  const red = pick('RED');
  const order = props.mySide === 'RED' ? ['RED', 'BLUE'] : ['BLUE', 'RED'];
  return order.map((team) => ({
    team,
    name: nameOf(team),
    rows: team === 'BLUE' ? blue : red,
    kills: (team === 'BLUE' ? blue : red).reduce((n: number, r: any) => n + r.kills, 0),
    won: props.result?.winner === team,
    comp: props.result?.composition?.[team.toLowerCase()] ?? null,
  }));
});

/** Player of the match: the best grade on the winning side, KDA breaking ties. */
const mvp = computed(() => {
  const rows = (props.result?.boxScore ?? []).filter((r: any) => r.team === props.result?.winner);
  return bestOf(rows);
});

/** When you lost, your own best still deserves a line. */
const yourBest = computed(() => {
  if (!props.mySide || won.value !== false) return null;
  return bestOf((props.result?.boxScore ?? []).filter((r: any) => r.team === props.mySide));
});

/**
 * The moments that decided it, as a short list a person can jump to. Not every event: the
 * firsts, the big neutral objectives and the aces. That is what a caster would replay.
 */
const MOMENT: Record<string, { label: string; weight: number; once?: boolean }> = {
  // Keyed on the event itself. It used to be the first gank or skirmish, which was often
  // not where the first kill happened at all.
  FIRST_BLOOD: { label: 'First blood', weight: 2, once: true },
  HERALD: { label: 'Herald', weight: 1, once: true },
  TOWER: { label: 'First tower', weight: 2, once: true },
  SOUL: { label: 'Dragon soul', weight: 4 },
  BARON: { label: 'Baron', weight: 5 },
  ELDER: { label: 'Elder dragon', weight: 5 },
  ACE: { label: 'Ace', weight: 4 },
  INHIBITOR: { label: 'First inhibitor', weight: 3, once: true },
  NEXUS: { label: 'Nexus', weight: 6, once: true },
};

const moments = computed(() => {
  const events = props.result?.events ?? [];
  const seen = new Set<string>();
  const out: any[] = [];
  for (const e of events) {
    const m = MOMENT[e.type];
    if (!m || !e.team) continue;
    const key = m.once ? m.label : `${m.label}-${e.seq}`;
    if (seen.has(m.label) && m.once) continue;
    seen.add(m.label);
    const label = e.payload?.stolen ? `${m.label} steal` : m.label;
    out.push({ t: e.t, seq: e.seq ?? key, team: e.team, label, weight: m.weight + (e.payload?.stolen ? 1 : 0), text: e.narration });
  }
  // Triple kills and better, and the steals of a dragon, from the big-moment list.
  for (const b of bigMoments.value) {
    if ((b.kind === 'MULTIKILL' && b.rank >= 5) || (b.kind === 'DRAGON')) {
      const [label, player] = b.text.split(': ');
      out.push({ t: b.t, seq: `big-${b.seq}`, team: b.team, label, who: player, weight: b.rank >= 6 ? 4 : 3, text: b.text });
    }
  }
  // Keep the heaviest seven, then show them in the order they happened.
  return out
    .sort((a, b) => b.weight - a.weight || a.t - b.t)
    .slice(0, 7)
    .sort((a, b) => a.t - b.t);
});

/** One line on the shape of the game, read off the gold graph. */
const story = computed(() => {
  const samples = props.result?.timeline ?? [];
  const winner = props.result?.winner;
  if (!samples.length || !winner) return '';
  const sign = winner === 'BLUE' ? 1 : -1;
  const worst = Math.min(...samples.map((s: any) => s.goldDiff * sign));
  const best = Math.max(...samples.map((s: any) => s.goldDiff * sign));
  if (worst < -2500) return `Comeback from ${(worst / 1000).toFixed(1)}k gold down`;
  if (worst >= -300) return best > 8000 ? 'Led from start to finish' : 'Never behind';
  return best > 6000 ? `Peaked ${(best / 1000).toFixed(1)}k ahead` : 'Close all the way';
});

/**
 * Why it went this way: two or three turning points, written from nothing but what the
 * result holds. Each reason needs its own data and is simply left out when the result
 * does not have it, so a duel stored by an older engine still gets the ones it can.
 */
const why = computed<string[]>(() => {
  const r = props.result;
  const winner = r?.winner;
  if (!r || !winner) return [];
  const loser = winner === 'BLUE' ? 'RED' : 'BLUE';
  const W = teamName(winner);
  const Wcap = W.charAt(0).toUpperCase() + W.slice(1);
  const L = teamName(loser);
  const events: any[] = r.events ?? [];
  const rows: any[] = r.boxScore ?? [];
  const sign = winner === 'BLUE' ? 1 : -1;
  const lines: { text: string; weight: number }[] = [];

  // The objective that opened the base.
  const inhib = events.find((e) => e.type === 'INHIBITOR' && e.team === winner);
  if (inhib) {
    const lane = ({ TOP: 'top', MID: 'mid', BOT: 'bot' } as Record<string, string>)[laneOfEvent(inhib)];
    const buff = [...events].reverse().find((e) =>
      (e.type === 'BARON' || e.type === 'ELDER') && e.team === winner && e.t <= inhib.t && inhib.t - e.t <= 240);
    if (buff) {
      const what = buff.type === 'BARON' ? 'Baron' : 'Elder';
      lines.push({ text: `${what} at ${clockText(buff.t)} opened the base: ${W} had the ${lane} inhibitor by ${clockText(inhib.t)}.`, weight: 5 });
    } else {
      lines.push({ text: `${Wcap} broke the ${lane} inhibitor at ${clockText(inhib.t)} and the base never closed again.`, weight: 3 });
    }
  }

  // The biggest three-minute gold swing towards the winner, and the fight inside it.
  const samples: any[] = r.timeline ?? [];
  let swing = { v: 0, from: 0, to: 0 };
  for (let i = 0; i + 3 < samples.length; i++) {
    const v = (samples[i + 3].goldDiff - samples[i].goldDiff) * sign;
    if (v > swing.v) swing = { v, from: samples[i].t, to: samples[i + 3].t };
  }
  if (swing.v >= 2500) {
    const fight = events.filter((e) => e.type === 'TEAMFIGHT_END' && e.team === winner && e.t >= swing.from && e.t <= swing.to)
      .sort((a, b) => (b.payload?.deaths?.loser ?? 0) - (a.payload?.deaths?.loser ?? 0))[0];
    const k = (swing.v / 1000).toFixed(1);
    lines.push({
      text: fight
        ? `The fight at ${clockText(fight.t)} started a ${k}k gold swing to ${W}.`
        : `${Wcap} gained ${k}k gold between ${clockText(swing.from)} and ${clockText(swing.to)}.`,
      weight: 4,
    });
  }

  // The draft.
  const comp = (side: string) => r.composition?.[side.toLowerCase()];
  const cw = Number(comp(winner)?.modifier) || 1;
  const cl = Number(comp(loser)?.modifier) || 1;
  if (Math.abs(cw - cl) >= 0.015) {
    const pctText = (x: number) => `${((x - 1) * 100 >= 0 ? '+' : '')}${((x - 1) * 100).toFixed(1)}%`;
    if (cw > cl) {
      const best = (comp(winner)?.factors ?? []).filter((f: any) => f.value > 0).sort((a: any, b: any) => b.value - a.value)[0];
      lines.push({ text: `The draft favoured ${W}: their comp was worth ${pctText(cw)} in fights${best ? `, mostly ${String(best.name).toLowerCase()}` : ''}.`, weight: 3 + (cw - cl) * 40 });
    } else {
      lines.push({ text: `${Wcap} won despite the weaker draft (${L} had ${pctText(cl)}).`, weight: 3 + (cl - cw) * 40 });
    }
  }

  // The squads on paper.
  const mean = (side: string) => {
    const s = rows.filter((x) => x.team === side && Number.isFinite(x.effRating));
    return s.length ? s.reduce((n, x) => n + x.effRating, 0) / s.length : null;
  };
  const mw = mean(winner);
  const ml = mean(loser);
  if (mw != null && ml != null && ml - mw >= 3) {
    lines.push({ text: `${Wcap} won as the weaker five on paper, ${Math.round(mw)} against ${Math.round(ml)} on average.`, weight: 4 });
  }

  // A card far from its best champion, when the result knows mastery; otherwise the
  // weakest card on the map, if it was also the one that kept dying.
  const offMain = rows.filter((x) => Number.isFinite(x.mastery) && x.mastery < 40)
    .sort((a, b) => a.mastery - b.mastery)[0];
  if (offMain) {
    lines.push({
      text: `${offMain.name} played ${offMain.champion || 'a champion'} at mastery ${offMain.mastery}, far from their best, and went ${offMain.kills}/${offMain.deaths}/${offMain.assists}.`,
      weight: offMain.team === loser ? 3.5 : 2.5,
    });
  } else {
    const losing = rows.filter((x) => x.team === loser && Number.isFinite(x.effRating));
    const weakest = [...losing].sort((a, b) => a.effRating - b.effRating)[0];
    const mostDeaths = Math.max(0, ...losing.map((x) => x.deaths));
    if (weakest && weakest.deaths >= 5 && weakest.deaths === mostDeaths) {
      lines.push({ text: `${weakest.name} was ${L}'s weakest card going in (${Math.round(weakest.effRating)}) and died ${weakest.deaths} times.`, weight: 2.5 });
    }
  }

  return lines.sort((a, b) => b.weight - a.weight).slice(0, 3).map((l) => l.text);
});

/** The final score, whatever the clock says: a rewatch must not rewrite the verdict. */
const finalKills = computed(() => {
  const out = { BLUE: 0, RED: 0 } as Record<string, number>;
  for (const r of props.result?.boxScore ?? []) out[r.team] = (out[r.team] ?? 0) + r.kills;
  return out;
});

/** How it ended, as a broadcaster would say it. */
const REASONS: Record<string, string> = { NEXUS: 'Nexus destroyed', SURRENDER: 'Surrender', TIME: 'Time limit' };
const reasonText = computed(() => {
  const r = String(props.result?.endReason || '').toUpperCase();
  if (!r) return '';
  const t = REASONS[r] || r.toLowerCase().replaceAll('_', ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
});

const pct = (v: number) => `${Math.round((v || 0) * 100)}%`;
const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v * 1000) / 10)}%`;
</script>

<template>
  <div v-if="result && score" class="watch" :class="{ 'watch--result-first': resultFirst && showResult }">
    <!-- Scoreboard ------------------------------------------------------------- -->
    <section ref="boardEl" class="board" aria-label="Scoreboard">
      <div class="board__side board__side--blue">
        <p class="board__name" :class="{ 'is-you': mySide === 'BLUE' }">
          <span class="board__label">{{ blueName }}</span>
          <span v-if="mySide === 'BLUE' && blueName !== 'You'" class="tag board__you">You</span>
        </p>
        <p class="board__buffs">
          <span v-for="b in score.buffs.BLUE" :key="b" class="buff">{{ b.toLowerCase() }}</span>
          <span v-if="score.dragons.BLUE" class="buff buff--quiet">{{ score.dragons.BLUE }} drake{{ score.dragons.BLUE > 1 ? 's' : '' }}</span>
        </p>
      </div>

      <p class="board__k board__k--blue tnum">{{ score.kills.BLUE }}</p>

      <div class="board__clock">
        <p class="board__time tnum">{{ clockText(clock) }}</p>
        <p class="board__gold tnum" :class="liveGold > 0 ? 'is-blue' : liveGold < 0 ? 'is-red' : ''">
          {{ liveGold === 0 ? 'Even' : `${liveGold > 0 ? '▲' : '▼'} ${(Math.abs(liveGold) / 1000).toFixed(1)}k` }}
        </p>
      </div>

      <p class="board__k board__k--red tnum">{{ score.kills.RED }}</p>

      <div class="board__side board__side--red">
        <p class="board__name" :class="{ 'is-you': mySide === 'RED' }">
          <span v-if="mySide === 'RED' && redName !== 'You'" class="tag board__you">You</span>
          <span class="board__label">{{ redName }}</span>
        </p>
        <p class="board__buffs">
          <span v-if="score.dragons.RED" class="buff buff--quiet">{{ score.dragons.RED }} drake{{ score.dragons.RED > 1 ? 's' : '' }}</span>
          <span v-for="b in score.buffs.RED" :key="b" class="buff">{{ b.toLowerCase() }}</span>
        </p>
      </div>

      <span class="board__progress" aria-hidden="true"><i :style="{ width: `${progress}%` }" /></span>
    </section>

    <div class="stage">
      <div class="stage__map">
        <RiftMap :positions="positions" :structures="structures" :flash="recent" />
        <!-- The big moment, over the map. Decorative: the live region below says it. -->
        <Transition name="moment-banner">
          <p
            v-if="banner" :key="banner.seq + banner.kind"
            class="banner" :class="`is-${banner.team.toLowerCase()}`" aria-hidden="true"
          >
            <span class="banner__text">{{ banner.text }}</span>
          </p>
        </Transition>
      </div>
      <p class="sr-only" aria-live="polite" aria-atomic="true">{{ announce }}</p>

      <div class="feed">
        <div class="feed__head">
          <span>Play by play</span>
          <button
            type="button" class="feed__all" :aria-pressed="showAll" data-sound="toggle"
            @click="toggleAll"
          >
            {{ showAll ? 'Showing everything' : 'Show everything' }}
          </button>
        </div>
        <ul class="ticker" aria-live="off">
          <li
            v-for="event in ticker" :key="event.seq"
            :class="[`is-${(event.team || 'none').toLowerCase()}`, { 'is-loud': LOUD.has(event.type) || event.payload?.stolen }]"
          >
            <span class="ticker__t tnum">{{ clockText(event.t) }}</span>
            <span class="ticker__text">{{ said(event.narration) }}</span>
          </li>
          <li v-if="!ticker.length" class="ticker__empty">Minions are on their way.</li>
        </ul>
      </div>
    </div>

    <!-- Gold lead over time, with the playhead. -->
    <figure v-if="graph" class="gold">
      <figcaption class="gold__cap">
        <span>Gold lead</span>
        <span v-if="graph.win" class="gold__chance">
          <i aria-hidden="true" class="gold__key" />Win chance
          <b class="tnum">{{ chanceText }}</b>
        </span>
        <span class="faint tnum">±{{ (graph.peak / 1000).toFixed(0) }}k</span>
      </figcaption>
      <p class="sr-only">{{ graph.summary }}</p>
      <svg class="gold__svg" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <clipPath id="mw-top"><rect x="0" y="0" width="100" height="20" /></clipPath>
          <clipPath id="mw-bot"><rect x="0" y="20" width="100" height="20" /></clipPath>
        </defs>
        <path :d="graph.area" class="gold__area gold__area--blue" clip-path="url(#mw-top)" />
        <path :d="graph.area" class="gold__area gold__area--red" clip-path="url(#mw-bot)" />
        <line x1="0" y1="20" x2="100" y2="20" class="gold__zero" />
        <path :d="graph.line" class="gold__line" />
        <path v-if="graph.win" :d="graph.win" class="gold__win" />
        <line :x1="progress" y1="0" :x2="progress" y2="40" class="gold__head" />
      </svg>
    </figure>

    <!-- Playback, for a parent whose clock can move. -->
    <slot name="controls" />

    <!-- The result ------------------------------------------------------------ -->
    <!-- Memoised: none of this moves with the clock, so it is not re-rendered every frame
         the replay plays. -->
    <template v-if="showResult">
    <section
      v-memo="[result, mySide, blueName, redName, seekable, resultFirst]"
      class="result" aria-labelledby="mw-verdict"
    >
      <header class="verdict" :class="won === true ? 'is-won' : won === false ? 'is-lost' : ''">
        <p class="verdict__eyebrow">
          {{ won === null ? 'Final' : won ? 'Victory' : 'Defeat' }}
        </p>
        <h2 id="mw-verdict" class="verdict__title">
          <span :class="result.winner === 'BLUE' ? 'is-blue' : 'is-red'">{{ nameOf(result.winner) }}</span>
          {{ nameOf(result.winner) === 'You' ? 'win' : 'wins' }}
        </h2>
        <p class="verdict__line">
          <span class="tnum verdict__score">
            <b class="is-blue">{{ finalKills.BLUE }}</b><i>–</i><b class="is-red">{{ finalKills.RED }}</b>
          </span>
          <span class="tnum">{{ clockText(length) }}</span>
          <span v-if="reasonText">{{ reasonText }}</span>
          <span v-if="story" class="verdict__story">{{ story }}</span>
        </p>
      </header>

      <div class="stars">
        <article v-if="mvp" class="star star--mvp">
          <p class="star__eyebrow"><span class="gem gem--legendary" aria-hidden="true" />Player of the match</p>
          <p class="star__name">{{ mvp.name }}</p>
          <p class="star__meta">
            {{ ROLE_NAME[mvp.slot] || mvp.slot }}<template v-if="mvp.champion"> · {{ mvp.champion }}</template>
          </p>
          <p class="star__line tnum">
            <span class="star__kda">{{ mvp.kills }}/{{ mvp.deaths }}/{{ mvp.assists }}</span>
            <span>{{ pct(mvp.killParticipation) }} KP</span>
            <span>{{ pct(mvp.damageShare) }} dmg</span>
          </p>
          <span class="grade grade--big" :data-grade="mvp.grade">{{ mvp.grade }}</span>
        </article>
        <article v-if="yourBest" class="star">
          <p class="star__eyebrow">Your best</p>
          <p class="star__name">{{ yourBest.name }}</p>
          <p class="star__meta">
            {{ ROLE_NAME[yourBest.slot] || yourBest.slot }}<template v-if="yourBest.champion"> · {{ yourBest.champion }}</template>
          </p>
          <p class="star__line tnum">
            <span class="star__kda">{{ yourBest.kills }}/{{ yourBest.deaths }}/{{ yourBest.assists }}</span>
            <span>{{ pct(yourBest.killParticipation) }} KP</span>
          </p>
          <span class="grade grade--big" :data-grade="yourBest.grade">{{ yourBest.grade }}</span>
        </article>
      </div>

      <section v-if="why.length" class="why" aria-labelledby="mw-why">
        <h3 id="mw-why" class="section-label">Why it went this way</h3>
        <ul class="why__list">
          <li v-for="line in why" :key="line">{{ said(line) }}</li>
        </ul>
      </section>

      <section v-if="moments.length" class="moments" aria-labelledby="mw-moments">
        <h3 id="mw-moments" class="section-label">What decided it</h3>
        <ol class="moments__list">
          <li v-for="m in moments" :key="m.seq">
            <component
              :is="seekable ? 'button' : 'div'"
              class="moment" :class="`is-${m.team.toLowerCase()}`"
              :type="seekable ? 'button' : undefined"
              :data-sound="seekable ? 'select' : undefined"
              :aria-label="seekable ? `Jump to ${m.label} at ${clockText(m.t)}` : undefined"
              @click="seekable && seekTo(m.t)"
            >
              <span class="moment__t tnum">{{ clockText(m.t) }}</span>
              <span class="moment__label">{{ m.label }}</span>
              <span class="moment__who">{{ m.who || nameOf(m.team) }}</span>
              <span v-if="seekable" class="moment__go" aria-hidden="true">▶</span>
            </component>
          </li>
        </ol>
      </section>

      <section class="teams" aria-label="Box score">
        <div v-for="side in sides" :key="side.team" class="team" :class="`team--${side.team.toLowerCase()}`">
          <header class="team__head">
            <p class="team__name">
              <span class="team__dot" aria-hidden="true" />
              {{ side.name }}
              <span v-if="side.team === mySide && side.name !== 'You'" class="tag">You</span>
            </p>
            <p class="team__res" :class="{ 'is-won': side.won }">
              {{ side.won ? 'Won' : 'Lost' }} · <span class="tnum">{{ side.kills }}</span> kills
            </p>
          </header>

          <div class="box-wrap">
            <table class="box">
              <thead>
                <tr>
                  <th scope="col">Player</th>
                  <th scope="col" class="num">K/D/A</th>
                  <th scope="col" class="num">KP</th>
                  <th scope="col" class="num">CS</th>
                  <th scope="col" class="num">Dmg</th>
                  <th scope="col" class="num">Grade</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in side.rows" :key="row.pid" :class="{ 'is-mvp': mvp && row.pid === mvp.pid }">
                  <th scope="row" class="box__who">
                    <span class="box__slot">{{ row.slot }}</span>
                    <span class="box__name">{{ row.name }}</span>
                    <span class="box__champ">{{ row.champion || '—' }}</span>
                  </th>
                  <td class="num tnum">{{ row.kills }}/{{ row.deaths }}/{{ row.assists }}</td>
                  <td class="num tnum">{{ pct(row.killParticipation) }}</td>
                  <td class="num tnum">{{ row.cs }}</td>
                  <td class="num tnum">{{ pct(row.damageShare) }}</td>
                  <td class="num"><span class="grade" :data-grade="row.grade">{{ row.grade }}</span></td>
                </tr>
              </tbody>
            </table>
          </div>

          <ul v-if="side.comp?.factors?.length" class="comp" aria-label="Draft">
            <li
              v-for="f in side.comp.factors" :key="f.name"
              :class="f.value > 0 ? 'is-plus' : f.value < 0 ? 'is-minus' : ''"
            >
              <span>{{ f.name }}</span>
              <b v-if="f.value" class="tnum">{{ signed(f.value) }}</b>
            </li>
          </ul>
        </div>
      </section>
    </section>
    </template>
  </div>
</template>

<style scoped>
.watch { display: grid; gap: 14px; }
/* Verdict, stars and moments lead; the box score stays below the map. */
.watch--result-first .result { display: contents; }
.watch--result-first .verdict, .watch--result-first .stars, .watch--result-first .why, .watch--result-first .moments { order: -1; }
.watch--result-first .moments { margin-bottom: 6px; }
.board { scroll-margin-top: 72px; }
.is-blue { color: var(--blue); }
.is-red { color: var(--red); }

/* --- scoreboard ----------------------------------------------------------- */
.board {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto auto minmax(0, 1fr);
  align-items: center;
  gap: 4px 12px;
  padding: 12px 14px 14px;
  background: linear-gradient(90deg, rgba(74, 144, 255, 0.12), var(--bg-2) 32%, var(--bg-2) 68%, rgba(240, 80, 95, 0.12));
  border: 1px solid var(--line-1);
  border-radius: 6px;
  overflow: hidden;
}
.board__side { min-width: 0; display: grid; gap: 6px; }
.board__side--red { text-align: right; justify-items: end; }
.board__name {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 13px;
  font-weight: 760;
  color: var(--ink-2);
}
.board__name.is-you { color: var(--ink-1); }
.board__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.board__you { flex: none; }
.board__k { margin: 0; font-stretch: 75%; font-weight: 860; font-size: 40px; line-height: 1; }
.board__k--blue { color: var(--blue); }
.board__k--red { color: var(--red); }
.board__clock { text-align: center; padding: 0 6px; }
.board__time { margin: 0; font-stretch: 75%; font-weight: 820; font-size: 22px; line-height: 1; color: var(--ink-1); }
.board__gold { margin: 4px 0 0; font-size: 12px; font-weight: 760; color: var(--ink-3); white-space: nowrap; }
.board__buffs { display: flex; flex-wrap: wrap; gap: 4px; margin: 0; min-height: 20px; }
.board__side--red .board__buffs { justify-content: flex-end; }
.buff {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 7px;
  font-size: 11px;
  font-weight: 760;
  font-stretch: 112%;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  background: rgba(216, 178, 104, 0.16);
  color: var(--gold-1);
  clip-path: polygon(4px 0, 100% 0, calc(100% - 4px) 100%, 0 100%);
}
.buff--quiet { background: var(--bg-4); color: var(--ink-2); }
.board__progress { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: var(--line-1); }
.board__progress i { display: block; height: 100%; background: var(--gold-2); }

@media (max-width: 560px) {
  .board { grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 6px 10px; padding: 10px 12px 12px; }
  .board__side--blue { grid-column: 1; grid-row: 1; }
  .board__side--red { grid-column: 3; grid-row: 1; }
  .board__clock { grid-column: 2; grid-row: 1 / span 2; }
  .board__k--blue { grid-column: 1; grid-row: 2; }
  .board__k--red { grid-column: 3; grid-row: 2; text-align: right; }
  .board__k { font-size: 34px; }
  .board__buffs { min-height: 0; }
}

/* --- map + feed ----------------------------------------------------------- */
.stage { display: grid; gap: 12px; }
.stage__map { min-width: 0; }
@media (min-width: 860px) {
  .stage { grid-template-columns: minmax(0, 1fr) 320px; align-items: stretch; }
}
.feed {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  background: var(--bg-2);
  border: 1px solid var(--line-1);
  border-radius: 6px;
  min-height: 0;
  max-height: 340px;
}
@media (min-width: 860px) { .feed { max-height: none; height: 100%; } }
.feed__head {
  margin: 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 4px 4px 4px 12px;
  border-bottom: 1px solid var(--line-1);
  font-size: 11px;
  font-weight: 760;
  font-stretch: 112%;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-3);
}
.ticker {
  list-style: none;
  margin: 0;
  padding: 6px 0;
  overflow-y: auto;
  min-height: 0;
  max-height: 290px;
  font-size: 14px;
  line-height: 1.45;
}
@media (min-width: 860px) { .ticker { max-height: 520px; } }
.ticker li {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  gap: 8px;
  padding: 5px 12px;
}
.ticker li:first-child { background: var(--bg-3); }
.ticker__t { color: var(--ink-3); font-size: 12.5px; font-weight: 700; padding-top: 1px; }
.ticker__text { color: var(--ink-2); }
.ticker li.is-blue .ticker__t { color: var(--blue); }
.ticker li.is-red .ticker__t { color: var(--red); }
.ticker li:first-child .ticker__text { color: var(--ink-1); }
.ticker__empty { color: var(--ink-3); display: block !important; }
.ticker li.is-loud .ticker__text { color: var(--gold-1); font-weight: 680; }
.feed__all {
  min-height: 44px;
  padding: 0 10px;
  border: 0;
  background: none;
  font: inherit;
  font-size: 11px;
  font-weight: 760;
  font-stretch: 112%;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-3);
  cursor: pointer;
}
.feed__all[aria-pressed='true'] { color: var(--ink-1); }
.feed__all:hover { color: var(--ink-1); }
.feed__all:focus-visible { outline: 2px solid var(--gold-1); outline-offset: -2px; }

/* --- the big-moment banner over the map ------------------------------------ */
.stage__map { position: relative; }
.banner {
  position: absolute;
  left: 50%;
  top: 12%;
  transform: translateX(-50%);
  margin: 0;
  max-width: calc(100% - 24px);
  padding: 8px 22px;
  background: linear-gradient(90deg, transparent, rgba(4, 7, 13, 0.92) 16%, rgba(4, 7, 13, 0.92) 84%, transparent);
  text-align: center;
  pointer-events: none;
}
.banner__text {
  display: block;
  font-stretch: 80%;
  font-weight: 880;
  font-size: clamp(18px, 4.2vw, 30px);
  line-height: 1.05;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--gold-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.banner::before, .banner::after {
  content: '';
  position: absolute;
  left: 18%;
  right: 18%;
  height: 1px;
  background: var(--gold-2);
  opacity: 0.6;
}
.banner::before { top: 0; }
.banner::after { bottom: 0; }
.banner.is-blue .banner__text { text-shadow: 0 0 18px rgba(74, 144, 255, 0.55); }
.banner.is-red .banner__text { text-shadow: 0 0 18px rgba(240, 80, 95, 0.55); }
.moment-banner-enter-active { transition: opacity 160ms ease-out, transform 260ms cubic-bezier(.2, .9, .25, 1.2); }
.moment-banner-leave-active { transition: opacity 320ms ease-in; }
.moment-banner-enter-from { opacity: 0; transform: translateX(-50%) scale(1.15); }
.moment-banner-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .moment-banner-enter-active, .moment-banner-leave-active { transition: opacity 120ms linear; }
  .moment-banner-enter-from { transform: translateX(-50%); }
}

/* --- why it went this way --------------------------------------------------- */
.why__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.why__list li {
  position: relative;
  padding: 10px 12px 10px 30px;
  background: var(--bg-2);
  border: 1px solid var(--line-1);
  border-radius: 4px;
  font-size: 14.5px;
  line-height: 1.45;
  color: var(--ink-1);
}
.why__list li::before {
  content: '';
  position: absolute;
  left: 12px;
  top: 17px;
  width: 7px;
  height: 7px;
  background: var(--gold-2);
  transform: rotate(45deg);
}

/* --- gold graph ----------------------------------------------------------- */
.gold { margin: 0; display: grid; gap: 6px; }
.gold__cap {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 0;
  justify-content: space-between;
  font-size: 11px;
  font-weight: 760;
  font-stretch: 112%;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-3);
}
.gold__svg { width: 100%; height: 56px; display: block; }
.gold__area--blue { fill: rgba(74, 144, 255, 0.28); }
.gold__area--red { fill: rgba(240, 80, 95, 0.28); }
.gold__zero { stroke: var(--line-2); stroke-width: 1; vector-effect: non-scaling-stroke; }
.gold__line { fill: none; stroke: var(--ink-2); stroke-width: 1.4; vector-effect: non-scaling-stroke; }
.gold__head { stroke: var(--gold-1); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.gold__win { fill: none; stroke: var(--gold-2); stroke-width: 1.4; stroke-dasharray: 3 2; vector-effect: non-scaling-stroke; opacity: 0.9; }
.gold__chance { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; margin-right: 12px; }
.gold__chance b { color: var(--ink-1); font-weight: 780; text-transform: none; letter-spacing: 0; }
.gold__key { width: 14px; height: 0; border-top: 1.5px dashed var(--gold-2); }

/* --- result --------------------------------------------------------------- */
.result { display: grid; gap: 18px; margin-top: 6px; }

.verdict {
  position: relative;
  padding: 22px 18px 20px;
  text-align: center;
  background:
    radial-gradient(120% 140% at 50% 0%, rgba(216, 178, 104, 0.14), transparent 60%),
    var(--bg-2);
  border: 1px solid var(--line-1);
  border-radius: 6px;
  overflow: hidden;
}
.verdict.is-won { border-color: rgba(216, 178, 104, 0.45); }
.verdict.is-lost {
  background: radial-gradient(120% 140% at 50% 0%, rgba(240, 80, 95, 0.12), transparent 60%), var(--bg-2);
}
.verdict__eyebrow {
  margin: 0;
  font-stretch: 116%;
  font-weight: 800;
  font-size: 12px;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--ink-3);
}
.verdict.is-won .verdict__eyebrow { color: var(--gold-1); }
.verdict.is-lost .verdict__eyebrow { color: var(--red); }
.verdict__title {
  margin: 6px 0 0;
  font-stretch: 75%;
  font-weight: 880;
  font-size: clamp(30px, 7vw, 48px);
  line-height: 1;
  text-transform: uppercase;
  color: var(--ink-1);
  overflow-wrap: anywhere;
}
.verdict.is-won .verdict__title { animation: verdict-in 520ms cubic-bezier(.2, .9, .25, 1.15) both; }
@keyframes verdict-in {
  from { opacity: 0; transform: scale(1.12); letter-spacing: 0.08em; }
  to { opacity: 1; transform: none; letter-spacing: normal; }
}
@media (prefers-reduced-motion: reduce) { .verdict.is-won .verdict__title { animation: none; } }
.verdict__line {
  margin: 12px 0 0;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 6px 14px;
  font-size: 14px;
  color: var(--ink-2);
}
.verdict__score { font-stretch: 75%; font-size: 22px; font-weight: 860; }
.verdict__score i { font-style: normal; color: var(--ink-3); margin: 0 4px; }
.verdict__story { color: var(--gold-1); font-weight: 700; }

.stars { display: grid; gap: 10px; }
@media (min-width: 640px) { .stars { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); } }
.star {
  position: relative;
  padding: 14px 76px 14px 16px;
  background: var(--bg-2);
  border: 1px solid var(--line-1);
  border-radius: 6px;
}
.star--mvp {
  background: linear-gradient(135deg, rgba(216, 178, 104, 0.16), transparent 60%), var(--bg-2);
  border-color: rgba(216, 178, 104, 0.38);
}
.star__eyebrow {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 780;
  font-stretch: 114%;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink-3);
}
.star--mvp .star__eyebrow { color: var(--gold-1); }
.star__name { margin: 6px 0 0; font-stretch: 80%; font-weight: 860; font-size: 26px; line-height: 1.05; color: var(--ink-1); overflow-wrap: anywhere; }
.star__meta { margin: 2px 0 0; font-size: 14px; color: var(--ink-2); }
.star__line { margin: 10px 0 0; display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 13.5px; color: var(--ink-2); }
.star__kda { color: var(--ink-1); font-weight: 800; }
.star .grade--big { position: absolute; right: 14px; top: 50%; transform: translateY(-50%); }

.section-label {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 780;
  font-stretch: 114%;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink-3);
}
.moments__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
@media (min-width: 720px) { .moments__list { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.moment {
  width: 100%;
  min-height: 48px;
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--bg-2);
  border: 1px solid var(--line-1);
  border-radius: 4px;
  font: inherit;
  color: var(--ink-1);
  text-align: left;
}
button.moment { cursor: pointer; transition: background 140ms, border-color 140ms; }
button.moment:hover { background: var(--bg-3); border-color: var(--line-2); }
button.moment:focus-visible { outline: 2px solid var(--gold-1); outline-offset: 2px; }
.moment__t { font-size: 13px; font-weight: 760; color: var(--ink-3); }
.moment__label { font-weight: 780; font-size: 15px; }
.moment__who { font-size: 13px; font-weight: 700; max-width: 14ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.moment.is-blue .moment__who { color: var(--blue); }
.moment.is-red .moment__who { color: var(--red); }
.moment__go { font-size: 10px; color: var(--ink-3); }

.teams { display: grid; gap: 14px; }
@media (min-width: 1100px) { .teams { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.team { background: var(--bg-2); border: 1px solid var(--line-1); border-radius: 6px; overflow: hidden; }
.team__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line-1);
}
.team--blue .team__head { background: linear-gradient(90deg, rgba(74, 144, 255, 0.14), transparent 70%); }
.team--red .team__head { background: linear-gradient(90deg, rgba(240, 80, 95, 0.14), transparent 70%); }
.team__name { margin: 0; display: flex; align-items: center; gap: 8px; min-width: 0; font-weight: 800; font-size: 15px; }
.team__dot { width: 9px; height: 9px; flex: none; transform: rotate(45deg); }
.team--blue .team__dot { background: var(--blue); }
.team--red .team__dot { background: var(--red); }
.team__res { margin: 0; flex: none; font-size: 13px; color: var(--ink-3); font-weight: 700; }
.team__res.is-won { color: var(--gold-1); }

.box-wrap { overflow-x: auto; }
.box { width: 100%; min-width: 440px; border-collapse: collapse; font-size: 14px; }
.box th, .box td { padding: 8px 10px; }
.box thead th {
  text-align: left;
  font-size: 11px;
  font-weight: 760;
  font-stretch: 112%;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-3);
  border-bottom: 1px solid var(--line-1);
}
.box .num { text-align: right; white-space: nowrap; }
.box tbody tr + tr > * { border-top: 1px solid var(--line-1); }
.box tbody tr.is-mvp { background: rgba(216, 178, 104, 0.08); }
.box__who {
  text-align: left;
  font-weight: inherit;
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  grid-template-areas: "slot name" "slot champ";
  column-gap: 8px;
  align-items: center;
}
.box__slot {
  grid-area: slot;
  font-size: 11px;
  font-weight: 800;
  font-stretch: 112%;
  color: var(--ink-3);
}
.box__name { grid-area: name; font-weight: 780; color: var(--ink-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.box__champ { grid-area: champ; font-size: 12.5px; color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.grade {
  display: inline-grid;
  place-items: center;
  min-width: 30px;
  height: 26px;
  padding: 0 4px;
  font-stretch: 75%;
  font-weight: 880;
  font-size: 17px;
  color: var(--ink-2);
  background: var(--bg-4);
  clip-path: polygon(5px 0, 100% 0, calc(100% - 5px) 100%, 0 100%);
}
.grade[data-grade="S+"], .grade[data-grade="S"] { background: var(--gold-2); color: var(--gold-ink); }
.grade[data-grade="A"] { background: rgba(216, 178, 104, 0.22); color: var(--gold-1); }
.grade[data-grade="C"], .grade[data-grade="D"] { color: var(--ink-3); }
.grade--big { min-width: 50px; height: 44px; font-size: 30px; clip-path: polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%); }

.comp {
  list-style: none;
  margin: 0;
  padding: 10px 14px 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  border-top: 1px solid var(--line-1);
}
.comp li {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 9px;
  font-size: 12.5px;
  color: var(--ink-2);
  background: var(--bg-3);
  border-radius: 3px;
}
.comp li b { font-size: 12px; }
.comp li.is-plus b { color: var(--teal-1); }
.comp li.is-minus b { color: var(--red); }
</style>
