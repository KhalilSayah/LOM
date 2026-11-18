/**
 * 3D interaction controller.
 *
 * Writes CSS custom properties and nothing else — all visual response lives in card.css,
 * so the look can be retuned without touching this file.
 *
 * Pointer (mouse) hovers; touch drags; a tap/click flips the card. Device orientation is
 * supported where the host grants it, and silently skipped where it does not (artifact
 * frames and most embedded webviews refuse motion APIs without prompting).
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * @param {HTMLElement} card
 * @param {{maxTilt?:number, scale?:number, flip?:boolean}} [opts]
 */
export function attachTilt(card, opts = {}) {
  const maxTilt = opts.maxTilt ?? 13;
  const hoverScale = opts.scale ?? 1.035;
  const allowFlip = opts.flip !== false;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let frame = 0;
  let target = { mxn: 0.5, myn: 0.5, active: 0 };
  let downAt = null;
  let engaged = false;   // true while a real pointer is driving the card

  function write() {
    frame = 0;
    const { mxn, myn, active } = target;
    const txn = (mxn - 0.5) * 2;
    const tyn = (myn - 0.5) * 2;
    const s = card.style;
    s.setProperty('--mxn', mxn.toFixed(4));
    s.setProperty('--myn', myn.toFixed(4));
    s.setProperty('--txn', txn.toFixed(4));
    s.setProperty('--tyn', tyn.toFixed(4));
    s.setProperty('--active', String(active));
    s.setProperty('--rx', `${(-tyn * maxTilt * active).toFixed(2)}deg`);
    s.setProperty('--ry', `${(txn * maxTilt * active).toFixed(2)}deg`);
    s.setProperty('--scale', String(1 + (hoverScale - 1) * active));
  }

  function schedule() {
    if (reduced) return;
    if (!frame) frame = requestAnimationFrame(write);
  }

  /** @param {number} clientX @param {number} clientY */
  function track(clientX, clientY) {
    const r = card.getBoundingClientRect();
    target.mxn = clamp((clientX - r.left) / r.width, 0, 1);
    target.myn = clamp((clientY - r.top) / r.height, 0, 1);
    target.active = 1;
    engaged = true;
    card.classList.add('is-tracking');
    schedule();
  }

  function release() {
    engaged = false;
    target.active = 0;
    target.mxn = 0.5;
    target.myn = 0.5;
    card.classList.remove('is-tracking');
    schedule();
  }

  card.addEventListener('pointerenter', (e) => track(e.clientX, e.clientY));
  card.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'touch' || downAt) track(e.clientX, e.clientY);
  });
  card.addEventListener('pointerleave', release);
  card.addEventListener('pointercancel', release);

  card.addEventListener('pointerdown', (e) => {
    downAt = { x: e.clientX, y: e.clientY, t: Date.now() };
    track(e.clientX, e.clientY);
  });

  card.addEventListener('pointerup', (e) => {
    const start = downAt;
    downAt = null;
    if (e.pointerType === 'touch') release();
    if (!allowFlip || !start) return;
    const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
    if (moved < 10 && Date.now() - start.t < 600) flip();
  });

  function flip() {
    card.classList.toggle('is-flipped');
    card.setAttribute('aria-pressed', String(card.classList.contains('is-flipped')));
  }

  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (allowFlip) flip();
    }
  });
  card.addEventListener('focus', () => { target.active = 1; schedule(); });
  card.addEventListener('blur', release);

  write();

  return {
    flip,
    reset: release,
    /**
     * Drive the card from outside — gyroscope, or an ambient idle sweep.
     * Ignored while a real pointer is on the card, so it never fights the user.
     * @param {number} x 0..1 @param {number} y 0..1 @param {number} [level] 0..1
     */
    point(x, y, level = 1) {
      if (engaged) return;
      target.mxn = x;
      target.myn = y;
      target.active = level;
      schedule();
    },
    get engaged() { return engaged; },
    destroy() { if (frame) cancelAnimationFrame(frame); },
  };
}

/**
 * Opt-in gyroscope tilt for the whole set. Resolves false where the host refuses.
 * @param {{point:(x:number,y:number)=>void, reset:()=>void}[]} controllers
 */
export async function enableGyro(controllers) {
  const DOE = /** @type {any} */ (window).DeviceOrientationEvent;
  if (!DOE) return false;
  try {
    if (typeof DOE.requestPermission === 'function') {
      const res = await DOE.requestPermission();
      if (res !== 'granted') return false;
    }
  } catch { return false; }

  let got = false;
  window.addEventListener('deviceorientation', (e) => {
    if (e.beta == null || e.gamma == null) return;
    got = true;
    const x = clamp(0.5 + e.gamma / 45, 0, 1);
    const y = clamp(0.5 + (e.beta - 40) / 45, 0, 1);
    for (const c of controllers) c.point(x, y);
  });

  await new Promise((r) => setTimeout(r, 400));
  return got;
}
