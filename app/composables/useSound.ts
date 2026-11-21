/**
 * Sound.
 *
 * Every sound in LOM is synthesised with Web Audio rather than shipped as a file: nothing to
 * license, nothing to download, and each one can be tuned to the moment (a Common gets one
 * clean note, an Icon gets the whole chord). The engine is a module-level singleton so every
 * screen shares one AudioContext and one master volume.
 *
 * Browsers only allow audio after a gesture, so the context is created lazily and resumed by
 * the first tap (see plugins/sound.client.ts). Until then every call is a silent no-op — a
 * sound that cannot play must never throw or delay the thing it accompanies.
 *
 * Frequency gate, same as motion: the things a player does a hundred times a session (tabs,
 * filters) get a whisper; the rare moments (a reveal, a win) get the full treatment.
 */

export type SoundName =
  | 'tap' | 'tick' | 'select' | 'toggle' | 'back'
  | 'coin' | 'gift' | 'error' | 'success'
  | 'packCharge' | 'packTear' | 'cardRise' | 'cardFlip'
  | 'revealCommon' | 'revealRare' | 'revealEpic' | 'revealLegendary' | 'revealIcon'
  | 'searchStart' | 'matchFound' | 'yourTurn' | 'lockIn' | 'ban' | 'theirLock'
  | 'timerTick' | 'timerUrgent' | 'draftDone'
  | 'kill' | 'objective' | 'baron' | 'victory' | 'defeat'
  | 'slotIn' | 'chemistry';

const STORE_KEY = 'lom-sound';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;
let lastPlayed: Record<string, number> = {};

const enabled = ref(true);
const volume = ref(0.7);
let loaded = false;

function loadPrefs() {
  if (loaded || typeof window === 'undefined') return;
  loaded = true;
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (raw) {
      const prefs = JSON.parse(raw);
      enabled.value = prefs.enabled !== false;
      if (typeof prefs.volume === 'number') volume.value = Math.min(1, Math.max(0, prefs.volume));
    }
  } catch { /* private mode: defaults stand */ }
}

function savePrefs() {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify({ enabled: enabled.value, volume: volume.value }));
  } catch { /* nothing to do */ }
}

function ensure(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = volume.value;
    // A gentle limiter so a stack of sounds (a reveal over a tap) never clips.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    master.connect(comp).connect(ctx.destination);
    // Mix with whatever music the player has on, where the platform lets us say so.
    try { (navigator as any).audioSession && ((navigator as any).audioSession.type = 'ambient'); } catch { /* */ }
  }
  return ctx;
}

/** Called from the first gesture. */
export function unlockAudio() {
  loadPrefs();
  const c = ensure();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}

function noise(c: AudioContext) {
  if (noiseBuffer) return noiseBuffer;
  const len = c.sampleRate * 1.2;
  noiseBuffer = c.createBuffer(1, len, c.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return noiseBuffer;
}

// --- building blocks ----------------------------------------------------------

interface ToneOpts {
  freq: number;
  to?: number;
  type?: OscillatorType;
  at?: number;
  dur?: number;
  gain?: number;
  attack?: number;
  release?: number;
  detune?: number;
  pan?: number;
}

function tone(c: AudioContext, o: ToneOpts) {
  const t0 = c.currentTime + (o.at ?? 0);
  const dur = o.dur ?? 0.2;
  const osc = c.createOscillator();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.freq, t0);
  if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t0 + dur);
  if (o.detune) osc.detune.value = o.detune;
  const g = c.createGain();
  const peak = o.gain ?? 0.2;
  const attack = o.attack ?? 0.005;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + (o.release ?? 0.08));
  let node: AudioNode = osc.connect(g);
  if (o.pan && c.createStereoPanner) {
    const p = c.createStereoPanner();
    p.pan.value = o.pan;
    node = node.connect(p);
  }
  node.connect(master!);
  osc.start(t0);
  osc.stop(t0 + dur + (o.release ?? 0.08) + 0.05);
}

interface NoiseOpts {
  at?: number;
  dur?: number;
  gain?: number;
  type?: BiquadFilterType;
  freq?: number;
  to?: number;
  q?: number;
  attack?: number;
}

function hiss(c: AudioContext, o: NoiseOpts) {
  const t0 = c.currentTime + (o.at ?? 0);
  const dur = o.dur ?? 0.2;
  const src = c.createBufferSource();
  src.buffer = noise(c);
  const f = c.createBiquadFilter();
  f.type = o.type ?? 'bandpass';
  f.frequency.setValueAtTime(o.freq ?? 2000, t0);
  if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t0 + dur);
  f.Q.value = o.q ?? 1;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(o.gain ?? 0.15, t0 + (o.attack ?? 0.01));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f).connect(g).connect(master!);
  src.start(t0, Math.random() * 0.5);
  src.stop(t0 + dur + 0.05);
}

/** A bell-ish note: a sine with a quiet inharmonic partial, the "hextech chime". */
function chime(c: AudioContext, freq: number, at = 0, gain = 0.16, dur = 0.9) {
  tone(c, { freq, at, dur, gain, attack: 0.004, release: 0.4 });
  tone(c, { freq: freq * 2.76, at, dur: dur * 0.45, gain: gain * 0.22, attack: 0.003, release: 0.2 });
  tone(c, { freq: freq * 2, at, dur: dur * 0.6, gain: gain * 0.18, type: 'triangle', attack: 0.004, release: 0.3 });
}

function sparkle(c: AudioContext, at: number, count: number, base = 1760) {
  for (let i = 0; i < count; i++) {
    const f = base * Math.pow(2, ((i * 7) % 12) / 12) * (i % 2 ? 1.5 : 1);
    tone(c, { freq: f, at: at + i * 0.045, dur: 0.12, gain: 0.045, attack: 0.002, release: 0.12, pan: (i % 3) - 1 });
  }
}

function boom(c: AudioContext, at = 0, gain = 0.5) {
  tone(c, { freq: 120, to: 38, at, dur: 0.5, gain, attack: 0.004, release: 0.2 });
  hiss(c, { at, dur: 0.25, gain: gain * 0.25, type: 'lowpass', freq: 900, to: 120 });
}

// --- the library ----------------------------------------------------------------

const N = (semi: number, root = 440) => root * Math.pow(2, semi / 12);

const RECIPES: Record<SoundName, (c: AudioContext) => void> = {
  // the interface: quiet, short, tactile
  tap: (c) => { hiss(c, { dur: 0.035, gain: 0.05, freq: 3200, q: 2 }); tone(c, { freq: 1300, to: 900, dur: 0.03, gain: 0.025 }); },
  tick: (c) => tone(c, { freq: 1900, dur: 0.018, gain: 0.03, type: 'triangle' }),
  select: (c) => { tone(c, { freq: 880, to: 1320, dur: 0.05, gain: 0.06, type: 'triangle' }); },
  toggle: (c) => { tone(c, { freq: 660, dur: 0.04, gain: 0.05, type: 'triangle' }); tone(c, { freq: 990, at: 0.05, dur: 0.05, gain: 0.05, type: 'triangle' }); },
  back: (c) => tone(c, { freq: 900, to: 600, dur: 0.06, gain: 0.04, type: 'triangle' }),
  error: (c) => { tone(c, { freq: 196, dur: 0.12, gain: 0.08, type: 'square' }); tone(c, { freq: 165, at: 0.12, dur: 0.16, gain: 0.08, type: 'square' }); },
  success: (c) => { chime(c, N(7, 880), 0, 0.08, 0.3); chime(c, N(12, 880), 0.08, 0.08, 0.4); },

  // value: coins and gifts
  coin: (c) => { tone(c, { freq: 1975, dur: 0.06, gain: 0.08 }); tone(c, { freq: 2637, at: 0.06, dur: 0.18, gain: 0.08 }); },
  gift: (c) => { [0, 4, 7, 12].forEach((s, i) => chime(c, N(s, 1046.5), i * 0.07, 0.07, 0.5)); },

  // the pack
  packCharge: (c) => {
    hiss(c, { dur: 0.7, gain: 0.12, freq: 300, to: 3200, q: 3, attack: 0.5 });
    tone(c, { freq: 110, to: 330, dur: 0.65, gain: 0.08, type: 'sawtooth', attack: 0.4 });
    for (let i = 0; i < 4; i++) hiss(c, { at: 0.12 + i * 0.12, dur: 0.05, gain: 0.05, freq: 1200 + i * 300, q: 4 });
  },
  packTear: (c) => {
    hiss(c, { dur: 0.32, gain: 0.3, type: 'highpass', freq: 600, to: 5000, q: 0.7, attack: 0.004 });
    hiss(c, { at: 0.04, dur: 0.18, gain: 0.12, freq: 2500, q: 6 });
  },
  cardRise: (c) => hiss(c, { dur: 0.5, gain: 0.09, freq: 400, to: 2400, q: 1.5, attack: 0.2 }),
  cardFlip: (c) => { hiss(c, { dur: 0.16, gain: 0.12, freq: 1800, to: 600, q: 1.2 }); tone(c, { freq: 520, to: 260, dur: 0.08, gain: 0.05, type: 'triangle' }); },

  // the reveal: drama in proportion to what came out
  revealCommon: (c) => chime(c, N(0, 523.25), 0, 0.1, 0.5),
  revealRare: (c) => { chime(c, N(0, 523.25), 0, 0.11, 0.5); chime(c, N(7, 523.25), 0.09, 0.11, 0.7); },
  revealEpic: (c) => {
    [0, 3, 7, 10].forEach((s, i) => chime(c, N(s, 523.25), i * 0.07, 0.11, 0.8));
    sparkle(c, 0.3, 5, 2093);
  },
  revealLegendary: (c) => {
    boom(c, 0, 0.35);
    [0, 4, 7, 12, 16].forEach((s, i) => chime(c, N(s, 523.25), 0.05 + i * 0.075, 0.12, 1.1));
    tone(c, { freq: N(-12, 523.25), at: 0.05, dur: 1.4, gain: 0.06, type: 'triangle', attack: 0.05, release: 0.8 });
    sparkle(c, 0.45, 8, 2093);
  },
  revealIcon: (c) => {
    boom(c, 0, 0.5);
    hiss(c, { dur: 1.2, gain: 0.08, freq: 3000, to: 9000, q: 0.8, attack: 0.3 });
    [0, 4, 7, 11, 14, 19].forEach((s, i) => chime(c, N(s, 392), 0.08 + i * 0.08, 0.12, 1.4));
    [0, 7, 12].forEach((s) => tone(c, { freq: N(s - 12, 392), at: 0.1, dur: 1.8, gain: 0.05, type: 'sawtooth', attack: 0.2, release: 1 }));
    sparkle(c, 0.5, 14, 2349);
  },

  // the duel
  searchStart: (c) => { tone(c, { freq: 440, dur: 0.1, gain: 0.07, type: 'triangle' }); tone(c, { freq: 660, at: 0.1, dur: 0.16, gain: 0.07, type: 'triangle' }); },
  matchFound: (c) => {
    boom(c, 0, 0.3);
    [0, 7, 12].forEach((s, i) => chime(c, N(s, 440), 0.05 + i * 0.11, 0.13, 0.7));
  },
  yourTurn: (c) => { chime(c, N(7, 659.25), 0, 0.12, 0.35); chime(c, N(12, 659.25), 0.12, 0.12, 0.5); },
  lockIn: (c) => {
    tone(c, { freq: 160, to: 55, dur: 0.22, gain: 0.35, attack: 0.002 });
    hiss(c, { dur: 0.06, gain: 0.2, freq: 3000, q: 1 });
    chime(c, N(12, 440), 0.04, 0.1, 0.6);
  },
  ban: (c) => {
    tone(c, { freq: 220, to: 70, dur: 0.3, gain: 0.3, type: 'sawtooth', attack: 0.002 });
    hiss(c, { dur: 0.2, gain: 0.12, type: 'lowpass', freq: 1500, to: 200 });
  },
  theirLock: (c) => { tone(c, { freq: 140, to: 70, dur: 0.14, gain: 0.16 }); tone(c, { freq: 880, at: 0.02, dur: 0.12, gain: 0.03, type: 'triangle' }); },
  timerTick: (c) => tone(c, { freq: 1200, dur: 0.025, gain: 0.05, type: 'square' }),
  timerUrgent: (c) => { tone(c, { freq: 1600, dur: 0.04, gain: 0.08, type: 'square' }); tone(c, { freq: 1600, at: 0.09, dur: 0.04, gain: 0.06, type: 'square' }); },
  draftDone: (c) => { boom(c, 0, 0.3); [0, 4, 7].forEach((s, i) => chime(c, N(s, 523.25), 0.08 + i * 0.06, 0.1, 0.9)); },

  // the match
  kill: (c) => { tone(c, { freq: 740, to: 370, dur: 0.12, gain: 0.07, type: 'triangle' }); hiss(c, { dur: 0.08, gain: 0.05, freq: 2400, q: 3 }); },
  objective: (c) => { tone(c, { freq: 196, dur: 0.45, gain: 0.12, type: 'sawtooth', attack: 0.04, release: 0.3 }); tone(c, { freq: 294, at: 0.05, dur: 0.4, gain: 0.08, type: 'sawtooth', attack: 0.04, release: 0.3 }); },
  baron: (c) => { boom(c, 0, 0.45); tone(c, { freq: 98, dur: 0.9, gain: 0.14, type: 'sawtooth', attack: 0.06, release: 0.5 }); tone(c, { freq: 147, at: 0.1, dur: 0.8, gain: 0.1, type: 'sawtooth', attack: 0.06, release: 0.5 }); },
  victory: (c) => {
    boom(c, 0, 0.4);
    [[0, 0], [4, 0.12], [7, 0.24], [12, 0.42]].forEach(([s, at]) => chime(c, N(s!, 523.25), at!, 0.14, 1.2));
    [0, 4, 7].forEach((s) => tone(c, { freq: N(s - 12, 523.25), at: 0.42, dur: 1.6, gain: 0.05, type: 'sawtooth', attack: 0.1, release: 1 }));
    sparkle(c, 0.6, 10, 2093);
  },
  defeat: (c) => {
    [[0, 0], [-2, 0.2], [-5, 0.42]].forEach(([s, at]) => chime(c, N(s!, 392), at!, 0.11, 1));
    tone(c, { freq: N(-17, 392), at: 0.42, dur: 1.4, gain: 0.06, type: 'triangle', attack: 0.1, release: 0.9 });
  },

  // the team
  slotIn: (c) => { tone(c, { freq: 300, to: 120, dur: 0.1, gain: 0.18, attack: 0.002 }); hiss(c, { dur: 0.04, gain: 0.08, freq: 2600, q: 2 }); },
  chemistry: (c) => { chime(c, N(0, 880), 0, 0.07, 0.4); chime(c, N(4, 880), 0.06, 0.07, 0.4); chime(c, N(7, 880), 0.12, 0.07, 0.6); },
};

/** Minimum gap between two plays of the same sound, so a burst of events stays readable. */
const MIN_GAP: Partial<Record<SoundName, number>> = {
  tap: 60, tick: 40, select: 50, kill: 90, timerTick: 400, theirLock: 200,
};

export function playSound(name: SoundName) {
  loadPrefs();
  if (!enabled.value || volume.value <= 0) return;
  const c = ensure();
  if (!c || !master || c.state !== 'running') return;
  const now = performance.now();
  const gap = MIN_GAP[name] ?? 30;
  if (now - (lastPlayed[name] ?? 0) < gap) return;
  lastPlayed[name] = now;
  try { RECIPES[name](c); } catch { /* a sound never breaks a screen */ }
}

export function revealSoundFor(rarity: string | null | undefined): SoundName {
  switch ((rarity || '').toUpperCase()) {
    case 'ICON': return 'revealIcon';
    case 'LEGENDARY': return 'revealLegendary';
    case 'EPIC': return 'revealEpic';
    case 'RARE': return 'revealRare';
    default: return 'revealCommon';
  }
}

export function useSound() {
  loadPrefs();
  function setEnabled(on: boolean) {
    enabled.value = on;
    savePrefs();
    if (on) { unlockAudio(); playSound('toggle'); }
  }
  function setVolume(v: number) {
    volume.value = Math.min(1, Math.max(0, v));
    if (master) master.gain.value = volume.value;
    savePrefs();
  }
  return { enabled, volume, play: playSound, setEnabled, setVolume, revealSoundFor };
}
