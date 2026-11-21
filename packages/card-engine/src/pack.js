/**
 * Pack opening.
 *
 * The one moment in LOM where a card is not information but an event. docs/01-game-loop.md
 * gives a pack after a match; this is what that looks like.
 *
 * The sequence is a state machine, not a single animation, because the interesting part is
 * the pause: the pack charges, the light builds, and the player does not yet know what they
 * have. Each phase is a `data-phase` value on the scene and every visual response lives in
 * pack.css — same split as tilt.js, so the timing can be retuned without touching the look
 * and the look retuned without touching the timing.
 *
 *   armed    pack has slid in and is waiting to be tapped
 *   charge   pressed: the pack swells, the seam lights, the rays start turning
 *   tear     the top comes away and light spills out of the opening
 *   rise     the card lifts out of the pack, still face down
 *   flip     it turns over; the rarity burst fires on the same frame
 *   done     card is interactive, actions are available
 *
 * The art is preloaded during `armed` and `charge`, so by the time the card turns over the
 * image is already decoded. A pack that reveals a blank card and paints it a beat later is
 * the one failure this whole screen cannot survive.
 */

import { RARITY_THEMES, themeVars } from './rarity.js';
import { roleGlyph, esc } from './artwork.js';
import { preloadCards } from './assets.js';
import { createCard, normaliseCard } from './card.js';

/** phase -> ms until the next phase. */
const TIMING = {
  charge: 620,
  tear: 440,
  rise: 540,
  flip: 760,
};

/**
 * The show scales with what is inside. A Common turns over briskly; an Icon is a moment.
 * `walk` is the walkout: Legendary and Icon cards hold face down while their identity is
 * read out a beat at a time (role, league, team, season) before the player is shown.
 * `motes` is the size of the burst.
 */
const BY_RARITY = {
  COMMON: { charge: 380, tear: 280, rise: 420, walk: 0, flip: 560, motes: 0 },
  RARE: { charge: 520, tear: 360, rise: 480, walk: 0, flip: 660, motes: 12 },
  EPIC: { charge: 660, tear: 420, rise: 560, walk: 0, flip: 760, motes: 22 },
  LEGENDARY: { charge: 820, tear: 460, rise: 620, walk: 1800, flip: 860, motes: 34 },
  ICON: { charge: 1050, tear: 520, rise: 720, walk: 2700, flip: 960, motes: 48 },
};

/**
 * How long the card is allowed to hang face-down waiting for its art.
 *
 * The reveal is the one moment in the game that is pure theatre, and a card that turns
 * over blank and fills in a beat later ruins it. So the rise holds until the image has
 * decoded — but never past this, because a stalled CDN must not mean a pack that cannot
 * be opened. Past the cap the card turns anyway and paints when it lands.
 */
const ART_HOLD_MS = 5000;

/** The LOM mark: a diamond inside a diamond, the same shape as the Battle button. */
const PACK_CREST = '<svg viewBox="0 0 28 28" aria-hidden="true">'
  + '<path d="M14 2l12 12-12 12L2 14z" fill="none" stroke="currentColor" stroke-width="1.2"/>'
  + '<path d="M14 7.5L20.5 14 14 20.5 7.5 14z" fill="currentColor"/>'
  + '</svg>';

/** @param {number} n */
function motes(n) {
  let out = '';
  for (let i = 0; i < n; i++) {
    const angle = (360 / n) * i + (i % 3) * 7;
    const dist = 38 + ((i * 37) % 46);
    const delay = (i % 5) * 26;
    const size = 2 + ((i * 13) % 5) * 0.6;
    out += `<span class="lom-burst__mote" style="--a:${angle}deg;--d:${dist}%;--t:${delay}ms;--s:${size}px"></span>`;
  }
  return out;
}

/**
 * Build a pack-opening scene for one card.
 *
 * @param {object} card raw or normalised card data
 * @param {{
 *   label?: string,
 *   autoArm?: boolean,
 *   onPhase?: (phase: string) => void,
 *   onReveal?: (card: object) => void,
 *   onHeld?: (ms: number) => void,
 *   onKeep?: (card: object) => void,
 * }} [opts]
 */
export function createPack(card, opts = {}) {
  const data = normaliseCard(card);
  const theme = RARITY_THEMES[data.rarity] || RARITY_THEMES.COMMON;
  const T = BY_RARITY[data.rarity] || BY_RARITY.COMMON;
  const reduced = typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const scene = document.createElement('div');
  scene.className = 'lom-pack-scene';
  scene.dataset.phase = 'idle';
  scene.dataset.rarity = data.rarity;
  scene.setAttribute('style', `${themeVars(data.rarity)};--walk:${T.walk}ms;--flip:${T.flip}ms`);

  scene.innerHTML = `
    <div class="lom-pack-scene__sky" aria-hidden="true">
      <span class="lom-rays"></span>
      <span class="lom-bloom"></span>
    </div>

    <div class="lom-pack-scene__floor">

      <div class="lom-pack" role="button" tabindex="0"
           aria-label="${esc(opts.label || 'Unopened pack')} — press to open">
        <span class="lom-pack__lid" aria-hidden="true">
          <span class="lom-pack__tear"></span>
        </span>
        <span class="lom-pack__body" aria-hidden="true">
          <span class="lom-pack__foil"></span>
          <span class="lom-pack__crest">${PACK_CREST}</span>
          <span class="lom-pack__word">LOM</span>
          <span class="lom-pack__sub">${esc(opts.label || 'Player pack')}</span>
          <span class="lom-pack__strip">1 card</span>
        </span>
        <span class="lom-pack__slit" aria-hidden="true"></span>
      </div>

      <div class="lom-pack-scene__slot">
        <span class="lom-burst" aria-hidden="true">
          <span class="lom-burst__ring"></span>
          <span class="lom-burst__flash"></span>
          ${motes(T.motes)}
        </span>
      </div>

    </div>

    <p class="lom-pack-scene__hint" aria-live="polite">Tap the pack to open</p>

    <div class="lom-walkout" aria-hidden="true">
      <span>${esc(data.role)}</span><span>${esc(data.region)}</span><span>${esc(data.team)}</span><span>${data.season}</span>
    </div>

    <div class="lom-pack-scene__banner" aria-hidden="true">
      <span class="lom-pack-scene__band"><span class="lom-gem lom-gem--${String(data.rarity).toLowerCase()}" aria-hidden="true"></span>${theme.label}</span>
    </div>

    <div class="lom-pack-scene__actions">
      <button type="button" class="lom-btn lom-btn--ghost" data-act="again">Open another</button>
      <button type="button" class="lom-btn" data-act="keep">Add to collection</button>
    </div>
  `;

  const packEl = /** @type {HTMLElement} */ (scene.querySelector('.lom-pack'));
  const slot = /** @type {HTMLElement} */ (scene.querySelector('.lom-pack-scene__slot'));
  const hint = /** @type {HTMLElement} */ (scene.querySelector('.lom-pack-scene__hint'));

  // The card exists from the start, face down inside the pack. Building it on reveal would
  // cost a layout and a decode at the exact moment the animation must not stutter.
  const built = createCard(data, { interactive: true, flip: true });
  built.el.classList.add('is-flipped');
  built.stage.classList.add('lom-pack-scene__card');
  slot.appendChild(built.stage);

  let phase = 'idle';
  let timers = [];
  const at = (ms, fn) => timers.push(setTimeout(fn, ms));
  const clear = () => { timers.forEach(clearTimeout); timers = []; };

  function setPhase(next) {
    phase = next;
    scene.dataset.phase = next;
    opts.onPhase?.(next);
  }

  /**
   * Decoded art, so the turn-over never shows an empty frame. Only the card's own art is
   * waited on: the four pool tiles at the foot are lazy and nobody notices them arriving
   * late, so making the reveal wait on four more requests would cost the thing it protects.
   */
  let artReady = preloadCards(data, { variant: 'card', essentialOnly: true, timeout: ART_HOLD_MS });

  function arm() {
    if (phase !== 'idle') return;
    setPhase('armed');
    hint.textContent = 'Tap the pack to open';
  }

  function open() {
    if (phase !== 'armed') return;

    if (reduced) {
      // No theatre: the card is simply there, face up, with the band shown.
      setPhase('done');
      artReady.then(() => {});
      built.el.classList.remove('is-flipped');
      hint.textContent = `${theme.label} — ${data.playerName} ${data.season}`;
      opts.onReveal?.(data);
      return;
    }

    setPhase('charge');
    hint.textContent = '';

    at(T.charge, () => setPhase('tear'));
    at(T.charge + T.tear, () => setPhase('rise'));
    at(T.charge + T.tear + T.rise, async () => {
      // Hold at `rise` — the card is out of the pack and face down, which reads as
      // anticipation rather than as a wait — until the art is ready or the cap expires.
      const held = Date.now();
      await Promise.race([artReady, new Promise((r) => setTimeout(r, ART_HOLD_MS))]);
      if (phase !== 'rise') return;   // reset() or destroy() happened while we waited
      opts.onHeld?.(Date.now() - held);

      if (T.walk) {
        setPhase('walkout');
        walkTimer = setTimeout(flip, T.walk);
        timers.push(walkTimer);
      } else {
        flip();
      }
    });
  }

  let walkTimer = null;

  /** Turn the card over. Also the skip: a tap during the walkout jumps straight here. */
  function flip() {
    if (phase !== 'rise' && phase !== 'walkout') return;
    if (walkTimer) { clearTimeout(walkTimer); walkTimer = null; }
    {
      setPhase('flip');
      built.el.classList.remove('is-flipped');
      opts.onReveal?.(data);

      at(T.flip, () => {
        setPhase('done');
        hint.textContent = `${data.playerName} ${data.season} — ${theme.label}, ${data.ovr} OVR`;
      });
    }
  }

  function reset() {
    clear();
    built.el.classList.add('is-flipped');
    built.controller?.reset();
    setPhase('idle');
    artReady = preloadCards(data, { variant: 'card', essentialOnly: true, timeout: ART_HOLD_MS });
    requestAnimationFrame(() => requestAnimationFrame(arm));
  }

  packEl.addEventListener('click', open);
  scene.addEventListener('click', () => { if (phase === 'walkout') flip(); });
  packEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });

  scene.querySelector('[data-act="keep"]')?.addEventListener('click', () => opts.onKeep?.(data));
  scene.querySelector('[data-act="again"]')?.addEventListener('click', reset);

  if (opts.autoArm !== false) {
    // One frame so the slide-in transition has a state to animate from.
    requestAnimationFrame(() => requestAnimationFrame(arm));
  }

  return {
    el: scene,
    card: data,
    controller: built.controller,
    arm,
    open,
    reset,
    get phase() { return phase; },
    destroy() { clear(); built.controller?.destroy(); scene.remove(); },
  };
}

/**
 * @param {HTMLElement} container
 * @param {object} card
 * @param {object} [opts]
 */
export function mountPack(container, card, opts = {}) {
  const pack = createPack(card, opts);
  container.appendChild(pack.el);
  return pack;
}
