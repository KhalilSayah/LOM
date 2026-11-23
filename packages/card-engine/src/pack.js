/**
 * Pack opening.
 *
 * The one moment in LOM where a card is not information but an event, so it is built like a
 * physical object. The pack drops with the card inside it. The player tears the foil with a
 * finger, the wrapper falls away, and the back of the card counts up one pip per rarity tier,
 * each slower than the last: when the count stops is the news. Then it turns over.
 *
 * Phases, on `data-phase`:
 *
 *   drop     the pack is arriving
 *   armed    waiting for a swipe or a tap
 *   tearing  the strip is coming away
 *   out      the wrapper is falling off the card
 *   tell     the pips, then who it might be for a Legendary or an Icon
 *   flip     it turns over
 *   hold     a pack of several: this card, before it goes to the tray
 *   done     card is interactive, the way out is available
 *
 * Sound is not this file's business. It reports what happened through `onCue` and the host
 * decides what that sounds like.
 *
 * The art is preloaded before the turn, so a card never turns over blank: the reveal waits
 * for it, up to a limit, because a stalled CDN must not mean a pack that cannot be opened.
 */

import { RARITY_THEMES } from './rarity.js';
import { preloadCards } from './assets.js';
import { createCard, normaliseCard } from './card.js';
import { bound, packTheme, loadPackArt } from './pack-art.js';
import { createFoil } from './pack-foil.js';

const ART_HOLD_MS = 5000;

/** Each tier spends more of everything: more pips, a longer hush, a harder landing. */
const TIERS = {
  COMMON: { level: 1, dim: 0, hush: 110, turns: 180, flip: 420, shake: 0, flakes: 0, wash: 0, shocks: 0, flakeColors: ['#9aa6ba'] },
  RARE: { level: 2, dim: 0.12, hush: 160, turns: 180, flip: 460, shake: 1.5, flakes: 8, wash: 0.1, shocks: 0, flakeColors: ['#4fa8ff', '#9ccfff', '#dbeeff'] },
  EPIC: { level: 3, dim: 0.36, hush: 240, turns: 540, flip: 720, shake: 4, flakes: 18, wash: 0.2, shocks: 1, flakeColors: ['#b583ff', '#d8bfff', '#f1e7ff', '#7c4fd0'] },
  LEGENDARY: { level: 4, dim: 0.62, hush: 420, turns: 540, flip: 820, shake: 8, flakes: 40, wash: 0.3, shocks: 2, flakeColors: ['#f2c14e', '#f5dfa8', '#fff4d6', '#a88340'] },
  ICON: { level: 5, dim: 0.84, hush: 620, turns: 900, flip: 1060, shake: 13, flakes: 72, wash: 0.42, shocks: 2, flakeColors: ['#a6f7ee', '#b9c6ff', '#e2b8ff', '#ffc6dd', '#ffe6a6', '#ffffff'] },
};
const PIP_GAPS = [190, 270, 340, 450, 640];

const ease = {
  linear: (t) => t,
  out: (t) => 1 - (1 - t) ** 3,
  in: (t) => t * t * t,
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  back: (t) => 1 + 2.25 * (t - 1) ** 3 + 1.25 * (t - 1) ** 2,
  spring: (t) => 1 - Math.exp(-6.5 * t) * Math.cos(13 * t),
};

const CREST = '<svg viewBox="0 0 28 28" aria-hidden="true">'
  + '<path d="M14 2l12 12-12 12L2 14z" fill="none" stroke="currentColor" stroke-width=".9"/>'
  + '<path d="M14 7.5L20.5 14 14 20.5 7.5 14z" fill="currentColor"/></svg>';
const SHOCK = '<svg class="lom-shock" viewBox="-50 -50 100 100" aria-hidden="true"><path d="M0-48 48 0 0 48-48 0z"/></svg>';

const motionOff = () => typeof window !== 'undefined' && (
  window.matchMedia('(prefers-reduced-motion: reduce)').matches
  || document.documentElement.dataset.motion === 'reduce'
);

/**
 * Build a pack-opening scene.
 *
 * @param {object|Array<object|{card: object, note?: string}>} input the card or cards inside
 * @param {{
 *   packType?: string,
 *   from?: {cx: number, cy: number, w: number},
 *   keepLabel?: string,
 *   autoArm?: boolean,
 *   onPhase?: (phase: string) => void,
 *   onCue?: (name: string, detail?: object) => void,
 *   onReveal?: (card: object) => void,
 *   onKeep?: (cards: object[]) => void,
 * }} [opts] `from` is where the pack is on screen now, in viewport pixels, so it can lift
 *   off that spot instead of dropping in
 */
export function createPack(input, opts = {}) {
  const packType = String(opts.packType || 'DAILY').toUpperCase();
  const theme = packTheme(packType);
  const reduced = motionOff();
  const cue = (name, detail) => opts.onCue?.(name, detail);

  const queue = (Array.isArray(input) ? input : [input])
    .filter(Boolean)
    .map((entry, key) => {
      const wrapped = Boolean(entry.card);
      const data = normaliseCard(wrapped ? entry.card : entry);
      return { data, key, tier: TIERS[data.rarity] ? data.rarity : 'COMMON', note: wrapped ? entry.note || '' : '' };
    })
    .sort((a, b) => TIERS[a.tier].level - TIERS[b.tier].level || a.key - b.key);
  const many = queue.length > 1;
  const best = queue[queue.length - 1];

  const scene = document.createElement('div');
  scene.className = 'lom-pack-scene';
  scene.dataset.phase = 'idle';
  scene.dataset.rarity = queue[0]?.tier || 'COMMON';
  scene.tabIndex = 0;
  scene.setAttribute('role', 'group');
  scene.setAttribute('aria-label', `${theme.label} pack`);
  if (many) scene.classList.add('has-tray');
  scene.innerHTML = `
    <div class="lom-world">
      <div class="lom-table"></div><div class="lom-dim"></div><div class="lom-wash"></div>
      ${SHOCK}${SHOCK}
      <canvas class="lom-fx" aria-hidden="true"></canvas>
      <div class="lom-shadow"></div>
      <div class="lom-rig">
        <div class="lom-rig__face lom-rig__front"></div>
        <div class="lom-rig__face lom-rig__back">
          <span class="lom-rig__crest">${CREST}</span>
          <span class="lom-pips"><i></i><i></i><i></i><i></i><i></i></span>
        </div>
        <div class="lom-sweep"></div>
      </div>
      <canvas class="lom-foil" aria-hidden="true"></canvas>
      <div class="lom-guide" hidden></div>
    </div>
    <div class="lom-tray" aria-hidden="true"></div>
    <div class="lom-clues" aria-hidden="true"></div>
    <div class="lom-hint" hidden><b>Swipe across the top to tear</b><span>Or tap the pack</span></div>
    <div class="lom-summary" aria-live="polite">
      <div class="lom-summary__grid"></div>
      <p class="lom-summary__title"></p>
      <p class="lom-summary__best"></p>
    </div>
    <div class="lom-result" aria-live="polite">
      <span class="lom-result__band"><i></i><span></span></span>
      <span class="lom-result__name"></span>
      <span class="lom-result__note"></span>
    </div>
    <div class="lom-pack-scene__actions" hidden>
      <button type="button" class="lom-btn" data-act="keep"></button>
    </div>
  `;

  const q = (s) => scene.querySelector(s);
  const world = q('.lom-world');
  const rig = q('.lom-rig');
  const front = q('.lom-rig__front');
  const back = q('.lom-rig__back');
  const tray = q('.lom-tray');
  const clues = q('.lom-clues');
  const result = q('.lom-result');
  const summary = q('.lom-summary');
  const sweep = q('.lom-sweep');
  const dimEl = q('.lom-dim');
  const washEl = q('.lom-wash');
  const shadow = q('.lom-shadow');
  const [shock1, shock2] = scene.querySelectorAll('.lom-shock');
  const fx = q('.lom-fx');
  const fctx = fx.getContext('2d');
  const actions = q('.lom-pack-scene__actions');
  const keepBtn = q('[data-act="keep"]');
  const pips = [...scene.querySelectorAll('.lom-pips i')];
  keepBtn.textContent = opts.keepLabel || (many ? `Add ${queue.length} to collection` : 'Add to collection');

  const foil = createFoil(q('.lom-foil'));
  if (foil) {
    foil.setPack(packType);
    // The print may still be waiting for its champions; repaint when they land.
    loadPackArt(packType).then(() => { if (!destroyed) foil.setPack(packType); });
  } else {
    q('.lom-foil').style.display = 'none';
  }

  const artReady = preloadCards(queue.map((c) => c.data), { variant: 'card', essentialOnly: true, timeout: ART_HOLD_MS });

  /* --- one clock drives card, wrapper and light --------------------------------- */
  let boost = 1;
  let runId = 0;
  let destroyed = false;
  let raf = 0;
  const tweens = new Set();
  const tween = (o, to, ms, e = ease.out) => {
    const from = {};
    for (const k in to) from[k] = o[k];
    return new Promise((done) => tweens.add({ o, from, to, ms: Math.max(1, ms), e, t: 0, id: runId, done }));
  };
  const wait = (ms) => tween({ v: 0 }, { v: 1 }, ms, ease.linear);
  const stepTweens = (dt) => {
    for (const w of tweens) {
      if (w.id !== runId) { tweens.delete(w); w.done(false); continue; }
      w.t += dt * 1000 * boost;
      const p = bound(w.t / w.ms);
      const v = w.e(p);
      for (const k in w.to) w.o[k] = w.from[k] + (w.to[k] - w.from[k]) * v;
      if (p >= 1) {
        for (const k in w.to) w.o[k] = w.to[k];
        tweens.delete(w);
        w.done(true);
      }
    }
  };

  /* --- scene state ---------------------------------------------------------------- */
  const P = { on: true, x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, t: 0, dir: 1, fly: 0 };
  const C = { x: 0, y: 0, z: 0, s: 1, rx: 0, ry: 180, rz: 0 };
  const S = { dim: 0, wash: 0, sweep: -70, s1: 0, s1o: 0, s2: 0, s2o: 0, shake: 0 };
  const light = { x: -0.25, y: 0.55, tx: -0.25, ty: 0.55 };
  let phase = 'idle';
  let W = 0;
  let H = 0;
  let cw = 230;
  let packW = 0;
  let packH = 0;
  let built = null;
  let skip = false;
  let lastGrain = 0;
  let lastT = 0;
  let drag = null;
  let completing = false;
  let cardInPack = Boolean(foil);

  function setPhase(next) {
    phase = next;
    scene.dataset.phase = next;
    q('.lom-hint').hidden = next !== 'armed';
    q('.lom-guide').hidden = next !== 'armed';
    actions.hidden = next !== 'done';
    opts.onPhase?.(next);
  }

  const rigGone = (on) => rig.classList.toggle('is-gone', on);

  function buildCard(c) {
    built?.controller?.destroy?.();
    front.textContent = '';
    built = createCard(c.data, { interactive: true, flip: true });
    front.appendChild(built.stage);
    const label = RARITY_THEMES[c.tier].label;
    q('.lom-result__band span').textContent = label;
    q('.lom-result__name').textContent = `${c.data.playerName} ${c.data.season}`;
    q('.lom-result__note').textContent = c.note;
    clues.textContent = '';
    [c.data.role, c.data.region, c.data.team, c.data.season].forEach((word) => {
      const el = document.createElement('span');
      el.textContent = word;
      clues.appendChild(el);
    });
    pips.forEach((i) => { i.className = ''; });
    useTier(c.tier);
  }

  function useTier(tier) {
    scene.dataset.rarity = tier;
    scene.style.setProperty('--lom-accent', RARITY_THEMES[tier].accent);
  }

  function setStack(left) {
    let s = 'inset 0 0 0 1px rgba(216,176,100,.34), inset 0 0 0 calc(var(--cw) * .028) #0a101b, inset 0 0 0 calc(var(--cw) * .032) rgba(216,176,100,.2)';
    for (let k = 1; k <= left; k++) s += `, ${-k * 2}px ${k * 3}px 0 0 #0a101b, ${-k * 2}px ${k * 3}px 0 1px rgba(216,176,100,.42)`;
    back.style.boxShadow = s;
  }

  function buildTray() {
    tray.textContent = '';
    tray.classList.remove('on');
    if (!many) return;
    queue.forEach((c) => {
      const slot = document.createElement('div');
      slot.className = 'lom-tray__slot';
      slot.appendChild(createCard(c.data, { compact: true, interactive: false }).stage);
      tray.appendChild(slot);
    });
  }

  function showSummary() {
    const grid = q('.lom-summary__grid');
    grid.textContent = '';
    grid.dataset.n = String(queue.length);
    [...tray.children].forEach((slot, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'lom-summary__card';
      wrap.style.setProperty('--i', i);
      if (slot.firstChild) wrap.appendChild(slot.firstChild);
      if (queue[i].note) {
        const note = document.createElement('small');
        note.textContent = queue[i].note;
        wrap.appendChild(note);
      }
      grid.appendChild(wrap);
    });
    q('.lom-summary__title').textContent = `${theme.label} pack: ${queue.length} cards`;
    q('.lom-summary__best').textContent = `Best pull: ${best.data.playerName} ${best.data.season}, ${RARITY_THEMES[best.tier].label}`;
    tray.classList.remove('on');
    rigGone(true);
    result.classList.remove('in');
    summary.classList.add('in');
    S.dim = TIERS[best.tier].dim * 0.4;
  }

  function start() {
    runId++;
    boost = 1;
    skip = false;
    drag = null;
    completing = false;
    flakes.length = 0;
    const from = opts.from && !start.used ? opts.from : null;
    start.used = true;
    const box = scene.getBoundingClientRect();
    Object.assign(P, from
      ? {
        on: Boolean(foil), x: from.cx - (box.left + box.width / 2), y: (box.top + box.height / 2) - from.cy,
        z: 0, rx: 0, ry: 0, rz: 0, sx: from.w / packW, sy: from.w / packW, t: 0, dir: 1, fly: 0,
      }
      : { on: Boolean(foil), x: 0, y: H * 1.25, z: 90, rx: 28, ry: -8, rz: -9, sx: 1, sy: 1, t: 0, dir: 1, fly: 0 });
    Object.assign(C, { x: 0, y: -cw * 0.06, z: 0, s: 1, rx: 0, ry: 180, rz: 0 });
    cardInPack = Boolean(foil);
    Object.assign(S, { dim: 0, wash: 0, sweep: -70, s1: 0, s1o: 0, s2: 0, s2o: 0, shake: 0 });
    lastGrain = 0;
    lastT = 0;
    rig.classList.remove('is-live');
    result.classList.remove('in');
    summary.classList.remove('in');
    rigGone(false);
    buildTray();
    buildCard(queue[0]);
    setStack(queue.length - 1);
    setPhase('drop');
    intro(Boolean(from));
  }

  async function intro(lifted) {
    const id = runId;
    if (reduced) {
      Object.assign(P, { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1 });
      setPhase('armed');
      return;
    }
    if (lifted) {
      // It keeps moving from exactly where the player saw it.
      tween(P, { rz: -1.2 }, 220, ease.out);
      await tween(P, { x: 0, y: 0, sx: 1, sy: 1 }, 430, ease.inOut);
      if (id !== runId) return;
      cue('settle');
      P.sx = 1.022;
      P.sy = 0.968;
      setPhase('armed');
      tween(P, { sx: 1, sy: 1, rz: 0 }, 460, ease.spring);
      return;
    }
    await tween(P, { y: 0, z: 0, rx: 0, ry: 0, rz: -1.4 }, 460, ease.in);
    if (id !== runId) return;
    cue('drop');
    S.shake = 3.2;
    P.sx = 1.045;
    P.sy = 0.93;
    setPhase('armed');
    tween(P, { sx: 1, sy: 1, rz: 0 }, 560, ease.spring);
  }

  /* --- tearing --------------------------------------------------------------------- */
  function onDown(e) {
    if (e.target.closest?.('.lom-pack-scene__actions')) return;
    if (phase === 'armed') {
      drag = { x: e.clientX, moved: false, id: e.pointerId };
      try { scene.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
      return;
    }
    if (phase === 'out' || phase === 'tell' || phase === 'hold') {
      skip = true;
      boost = 7;
    }
  }
  function onMove(e) {
    if (phase === 'armed' || phase === 'tearing' || phase === 'drop') {
      const r = scene.getBoundingClientRect();
      light.tx = bound(((e.clientX - r.left) / r.width - 0.5) * 2.2, -1, 1);
      light.ty = bound(-((e.clientY - r.top) / r.height - 0.5) * 2.2 + 0.15, -1, 1);
    }
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    if (!reduced && foil && !drag.moved && Math.abs(dx) > 7) {
      drag.moved = true;
      P.dir = dx > 0 ? 1 : -1;
      setPhase('tearing');
    }
    if (drag.moved && phase === 'tearing') {
      P.t = bound((dx * P.dir) / (packW * 0.86));
      P.ry = bound((dx / packW) * 9, -9, 9);
      P.rz = bound((dx / packW) * 1.6, -2, 2);
    }
  }
  async function onUp(e) {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const d = drag;
    drag = null;
    if (!d.moved) {
      if (phase === 'armed') autoTear();
      return;
    }
    if (phase !== 'tearing') return;
    if (P.t >= 0.42) {
      await completeTear();
      return;
    }
    const id = runId;
    await tween(P, { t: 0, ry: 0, rz: 0 }, 300, ease.back);
    if (id === runId && phase === 'tearing') {
      lastGrain = 0;
      setPhase('armed');
    }
  }
  function onKey(e) {
    if ((e.key === 'Enter' || e.key === ' ') && phase === 'armed' && e.target === scene) {
      e.preventDefault();
      autoTear();
    }
  }
  scene.addEventListener('pointerdown', onDown);
  scene.addEventListener('pointermove', onMove);
  scene.addEventListener('pointerup', onUp);
  scene.addEventListener('pointercancel', onUp);
  scene.addEventListener('keydown', onKey);

  async function autoTear() {
    if (reduced || !foil) {
      revealNow();
      return;
    }
    P.dir = 1;
    setPhase('tearing');
    await completeTear(430);
  }
  async function completeTear(ms) {
    if (completing) return;
    completing = true;
    const id = runId;
    await tween(P, { t: 1, rx: 0, ry: 0, rz: 0 }, ms ?? bound((1 - P.t) * 300, 70, 240), ms ? ease.inOut : ease.out);
    completing = false;
    if (id === runId) reveal(id);
  }

  /* --- the reveal ------------------------------------------------------------------- */
  function revealNow() {
    const T = TIERS[best.tier];
    cardInPack = false;
    P.on = false;
    C.ry = 0;
    C.y = 0;
    S.dim = T.dim * 0.5;
    S.wash = T.wash * 0.7;
    cue('land', { rarity: best.tier });
    queue.forEach((c) => opts.onReveal?.(c.data));
    if (many) {
      [...tray.children].forEach((slot) => slot.classList.add('is-in'));
      showSummary();
      setPhase('done');
      return;
    }
    pips.forEach((p, i) => p.classList.toggle('on', i < T.level));
    setPhase('done');
    rig.classList.add('is-live');
    result.classList.add('in');
  }

  async function revealCard(c, id, isLast) {
    const T = TIERS[c.tier];
    const live = () => id === runId;
    const quick = many && !isLast ? 0.6 : 1;
    useTier(c.tier);

    // The tell: one pip per tier, each slower than the last. Stopping early is the news.
    setPhase('tell');
    for (let i = 0; i < T.level; i++) {
      await wait(PIP_GAPS[i] * quick);
      if (!live()) return false;
      pips[i].classList.add('on');
      if (i === T.level - 1) pips[i].classList.add('last');
      if (!skip) cue('tick', { i });
      C.s = 1.03 + 0.012 * (i + 1);
      tween(C, { s: 1.03 + 0.004 * i }, 160, ease.out);
      if (i >= 2) tween(S, { dim: T.dim * (0.55 + (0.45 * (i + 1)) / T.level) }, 260, ease.out);
    }

    // Legendary and Icon read out who it might be before showing them.
    if (T.level >= 4) {
      const words = [...clues.children];
      const gap = T.level === 5 ? 560 : 440;
      for (let i = 0; i < words.length; i++) {
        await wait(gap);
        if (!live()) return false;
        words[i].classList.add('in');
        if (!skip) cue('clue', { i });
        S.shake = Math.max(S.shake, 1 + i * 0.5);
      }
      await wait(260);
      if (!live()) return false;
    }

    // Never turn over a blank card.
    await Promise.race([artReady, new Promise((done) => setTimeout(done, ART_HOLD_MS))]);
    if (!live()) return false;

    // Hold still, lean back, then turn.
    boost = 1;
    tween(C, { s: 0.95, rz: T.level >= 3 ? -2.2 : -1, rx: 5 }, T.hush * quick, ease.inOut);
    await wait(T.hush * quick);
    if (!live()) return false;

    setPhase('flip');
    [...clues.children].forEach((el) => el.classList.remove('in'));
    C.ry = T.turns;
    const halfTurns = Math.round(T.turns / 180);
    for (let i = 0; i < halfTurns; i++) cue('flip', { i, at: i * ((T.flip * 0.62) / 1000 / halfTurns) });
    await tween(C, { ry: 0, s: 1.1, rz: 0, rx: 0 }, T.flip, ease.back);
    if (!live()) return false;

    // The landing.
    cue('land', { rarity: c.tier });
    opts.onReveal?.(c.data);
    S.shake = T.shake;
    S.dim = Math.max(0, T.dim * 0.78);
    tween(S, { dim: T.dim * 0.58 }, 900, ease.out);
    if (T.wash) {
      S.wash = T.wash * 1.6;
      tween(S, { wash: T.wash }, 900, ease.out);
    } else {
      S.wash = 0;
    }
    if (T.flakes) burst(T.flakes, W / 2, H / 2, T.flakeColors, T.level >= 4 ? 1.15 : 0.8, -0.32);
    if (T.shocks >= 1) {
      S.s1 = 0.62;
      S.s1o = 0.95;
      tween(S, { s1: 2.5, s1o: 0 }, 720, ease.out);
    }
    if (T.shocks >= 2) {
      S.s2 = 0.62;
      S.s2o = 0.7;
      wait(90).then(() => { if (live()) tween(S, { s2: 3.1, s2o: 0 }, 880, ease.out); });
    }
    if (T.level >= 2) {
      sweep.style.opacity = 1;
      S.sweep = -70;
      tween(S, { sweep: 70 }, 620, ease.inOut).then(() => { if (live()) sweep.style.opacity = 0; });
    }
    await tween(C, { s: 1 }, T.level <= 2 ? 340 : 560, ease.spring);
    return live();
  }

  async function sendToTray(i, id) {
    const slot = tray.children[i];
    const a = slot.getBoundingClientRect();
    const b = scene.getBoundingClientRect();
    result.classList.remove('in');
    cue('shove', { light: true });
    await tween(C, {
      x: a.left + a.width / 2 - (b.left + b.width / 2),
      y: (b.top + b.height / 2) - (a.top + a.height / 2),
      s: a.width / cw,
      rz: 0,
      rx: 0,
    }, 300, ease.inOut);
    if (id !== runId) return false;
    slot.classList.add('is-in');
    cue('slot');
    rigGone(true);
    return true;
  }

  async function reveal(id) {
    const live = () => id === runId;
    const top = TIERS[best.tier];
    const pace = many ? 0.8 : top.level <= 2 ? 0.68 : 1;
    setPhase('out');

    // The strip comes away and the wrapper is pulled off the cards.
    cue('rip');
    burst(14, W / 2 + P.dir * packW * 0.4, H / 2 - packH * 0.39, theme.bits, 0.62, -0.75);
    tween(P, { fly: 1 }, 760, ease.linear);
    await wait(140 * pace);
    if (!live()) return;
    cardInPack = false;
    cue('pull');
    await tween(C, { y: packH * 0.15, s: 0.99 }, 300 * pace, ease.out);
    if (!live()) return;
    cue('shove');
    tween(P, { y: -H * 1.1, z: -40, rz: 13 * P.dir, rx: -32 }, 540, ease.in).then((ok) => { if (ok && live()) P.on = false; });
    tween(S, { dim: top.dim * 0.4 }, 500, ease.inOut);
    if (many) tray.classList.add('on');
    await tween(C, { y: 0, s: 1.03 }, 460 * pace, ease.inOut);
    if (!live()) return;

    for (let i = 0; i < queue.length; i++) {
      const last = i === queue.length - 1;
      if (i > 0) {
        buildCard(queue[i]);
        setStack(queue.length - 1 - i);
        Object.assign(C, { x: 0, y: -cw * 0.55, s: 0.9, ry: 180, rz: 0, rx: 0 });
        S.wash = 0;
        rigGone(false);
        skip = false;
        boost = 1;
        cue('next');
        await tween(C, { y: 0, s: 1.03 }, 260, ease.out);
        if (!live()) return;
      }
      if (!await revealCard(queue[i], id, last)) return;
      if (!many) break;
      setPhase('hold');
      skip = false;
      result.classList.add('in');
      await wait(last ? 1000 : 720);
      if (!live()) return;
      boost = 1;
      if (!await sendToTray(i, id)) return;
    }

    if (many) {
      showSummary();
      cue('summary');
      setPhase('done');
      return;
    }
    setPhase('done');
    rig.classList.add('is-live');
    result.classList.add('in');
  }

  /* --- foil flakes: small sheets that tumble and catch the light -------------------- */
  const flakes = [];
  let flakesDirty = false;
  function burst(n, x, y, colors, power, upward) {
    if (reduced) return;
    const reach = Math.min(W, H) * 1.9 * power;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = reach * (0.25 + Math.random() ** 1.6 * 0.95);
      flakes.push({
        x: x + (Math.random() - 0.5) * cw * 0.5,
        y: y + (Math.random() - 0.5) * cw * 0.5,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v + upward * reach * 0.55,
        w: 2 + Math.random() * 4.5,
        h: 1.2 + Math.random() * 3.2,
        rot: Math.random() * 6.28,
        vr: (Math.random() - 0.5) * 9,
        ph: Math.random() * 6.28,
        vph: 5 + Math.random() * 11,
        c: colors[i % colors.length],
        life: 1.15 + Math.random() * 0.95,
        t: 0,
      });
    }
  }
  function drawFlakes(dt) {
    fctx.clearRect(0, 0, W, H);
    for (let i = flakes.length - 1; i >= 0; i--) {
      const f = flakes[i];
      f.t += dt;
      if (f.t >= f.life) {
        flakes.splice(i, 1);
        continue;
      }
      const air = Math.exp(-2.7 * dt);
      f.vx = f.vx * air + Math.sin(f.ph * 0.4) * 26 * dt;
      f.vy = f.vy * air + 560 * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.rot += f.vr * dt;
      f.ph += f.vph * dt;
      const tumble = Math.cos(f.ph);
      const glint = Math.abs(tumble) ** 6;
      fctx.save();
      fctx.globalAlpha = bound((f.life - f.t) / 0.4) * (0.55 + 0.45 * Math.abs(tumble));
      fctx.translate(f.x, f.y);
      fctx.rotate(f.rot);
      fctx.scale(1, Math.max(0.08, Math.abs(tumble)));
      fctx.fillStyle = f.c;
      fctx.fillRect(-f.w / 2, -f.h / 2, f.w, f.h);
      if (glint > 0.55) {
        fctx.globalAlpha *= glint * 0.8;
        fctx.fillStyle = '#fff';
        fctx.fillRect(-f.w / 2, -f.h / 2, f.w, f.h);
      }
      fctx.restore();
    }
  }

  /* --- frame ------------------------------------------------------------------------- */
  function applyDOM(now) {
    rig.style.transform = cardInPack
      ? `translate3d(${P.x}px, ${-P.y}px, ${P.z}px) rotateZ(${-P.rz}deg) rotateX(${-P.rx}deg) rotateY(${P.ry}deg) translate3d(0, ${cw * 0.06}px, -2px) rotateY(180deg) scale(${P.sx}, ${P.sy})`
      : `translate3d(${C.x}px, ${-C.y}px, ${C.z}px) rotateZ(${C.rz}deg) rotateX(${C.rx}deg) rotateY(${C.ry}deg) scale(${C.s})`;
    const facing = !cardInPack && Math.cos((C.ry * Math.PI) / 180) > 0;
    front.style.visibility = facing ? 'visible' : 'hidden';
    back.style.visibility = facing ? 'hidden' : 'visible';
    dimEl.style.opacity = S.dim;
    washEl.style.opacity = S.wash;
    sweep.style.setProperty('--sw', `${S.sweep}%`);
    shock1.style.opacity = S.s1o;
    shock1.style.transform = `scale(${S.s1 || 0.6})`;
    shock2.style.opacity = S.s2o;
    shock2.style.transform = `scale(${S.s2 || 0.6})`;
    const lift = bound(P.y / (H || 1), -1, 1);
    shadow.style.opacity = rig.classList.contains('is-gone') ? 0 : P.on ? 0.72 * (1 - Math.abs(lift)) : 0.55;
    shadow.style.transform = P.on
      ? `translateY(${-P.y * 0.85}px) scale(${1 + Math.abs(lift) * 0.25})`
      : `translate(${C.x}px, ${-C.y}px) scale(${C.s})`;
    if (S.shake > 0.02) {
      const a = S.shake;
      world.style.transform = `translate(${Math.sin(now * 0.071) * a}px, ${Math.cos(now * 0.093) * a * 0.8}px) rotate(${Math.sin(now * 0.057) * a * 0.035}deg)`;
      S.shake *= Math.exp(-11 / 60);
    } else {
      world.style.transform = '';
    }
  }

  let lastNow = 0;
  function frame(now) {
    if (destroyed) return;
    const dt = Math.min(0.05, (now - (lastNow || now)) / 1000);
    lastNow = now;
    stepTweens(dt);
    if (phase === 'armed' && !drag) {
      light.tx = -0.25 + Math.sin(now / 1900) * 0.42;
      light.ty = 0.5 + Math.cos(now / 2600) * 0.26;
    }
    light.x += (light.tx - light.x) * Math.min(1, dt * 7);
    light.y += (light.ty - light.y) * Math.min(1, dt * 7);
    if (phase === 'armed' && !drag && !reduced) {
      P.ry += ((light.x + 0.25) * 5.5 - P.ry) * Math.min(1, dt * 5);
      P.rx += ((light.y - 0.5) * -5 - P.rx) * Math.min(1, dt * 5);
    }
    if (phase === 'tearing' || phase === 'out') {
      const v = Math.abs(P.t - lastT) / Math.max(dt, 0.001);
      if (P.t - lastGrain > 0.058) {
        cue('grain', { speed: bound(v / 4) });
        lastGrain = P.t;
      }
      if (P.t < lastGrain - 0.1) lastGrain = P.t;
      lastT = P.t;
    }
    applyDOM(now);
    if (foil) {
      if (P.on) foil.draw(P, { w: W, h: H }, { w: packW, h: packH }, light);
      else foil.clear();
    }
    if (flakes.length || flakesDirty) {
      drawFlakes(dt);
      flakesDirty = flakes.length > 0;
    }
    raf = requestAnimationFrame(frame);
  }

  function resize() {
    const r = scene.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    W = r.width;
    H = r.height;
    cw = Math.round(Math.min(W * 0.62, (H * 0.54) / 1.397, 340));
    packW = cw * 1.1;
    packH = packW * 1.52;
    scene.style.setProperty('--cw', `${cw}px`);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    foil?.resize(W, H, dpr);
    fx.width = Math.round(W * dpr);
    fx.height = Math.round(H * dpr);
    fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  let observer = null;
  let booted = false;
  function boot() {
    if (destroyed || booted) return;
    if (!scene.isConnected || !resize()) {
      raf = requestAnimationFrame(boot);
      return;
    }
    booted = true;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => resize());
      observer.observe(scene);
    }
    start();
    raf = requestAnimationFrame(frame);
    try { scene.focus({ preventScroll: true }); } catch { /* not focusable yet */ }
  }

  keepBtn.addEventListener('click', () => opts.onKeep?.(queue.map((c) => c.data)));

  if (opts.autoArm !== false) raf = requestAnimationFrame(boot);

  return {
    el: scene,
    card: best?.data,
    get controller() { return built?.controller; },
    arm: boot,
    open() { if (phase === 'armed') autoTear(); },
    reset() {
      if (booted) start();
      else boot();
    },
    get phase() { return phase; },
    destroy() {
      destroyed = true;
      runId++;
      cancelAnimationFrame(raf);
      observer?.disconnect();
      built?.controller?.destroy?.();
      foil?.destroy();
      scene.remove();
    },
  };
}

/**
 * @param {HTMLElement} container
 * @param {object|object[]} cards
 * @param {object} [opts]
 */
export function mountPack(container, cards, opts = {}) {
  const pack = createPack(cards, opts);
  container.appendChild(pack.el);
  return pack;
}
