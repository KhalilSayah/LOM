<script setup lang="ts">
/**
 * Summoner's Rift: Riot's own minimap art, with ten dots and the structures still
 * standing drawn over it.
 *
 * Canvas 2D rather than SVG because this redraws every animation frame at up to 60×
 * speed, and ten DOM nodes moving at that rate is how you make a phone warm. It only
 * redraws when something it draws has changed, though: a paused replay, or a duel
 * waiting on its clock, costs nothing.
 *
 * The two sides differ by shape as well as colour — blue champions and towers are
 * round and square, red ones are diamonds — so nobody has to tell the teams apart by
 * hue alone.
 *
 * Rift coordinates run 0..14870 with y pointing up and blue in the bottom-left
 * corner, which is the orientation every League player already has in their head.
 * Canvas y points down, so every draw flips it — `project()` is the only place that
 * knows, and everything else uses map coordinates as given.
 *
 * The art is whatever sits in public/map (scripts/fetch-map.mjs fetches Riot's
 * minimap as a default). Swapping it is a file copy: the only thing tying the drawing
 * to a particular image is BOUNDS below, which says what span of game coordinates the
 * image frames, and /map-check.html exists to find those numbers.
 */

import { STRUCTURES } from '~~/packages/sim/src/map.js';

const props = defineProps<{
  positions: any[];
  structures: any;
  /**
   * The thing that just happened. `at` is the performance.now() it happened at, and the
   * ring animates for FLASH_MS of real time from then — not game time, which at 60x would
   * be gone in a frame. Without `at` it is drawn as a still ring.
   */
  flash?: { x: number; y: number; kind: string; at?: number } | null;
}>();

const FLASH_MS = 700;
const BIG_FLASH = new Set(['MULTIKILL', 'ACE', 'BARON', 'ELDER', 'SOUL', 'NEXUS', 'FIRST_BLOOD', 'DRAGON', 'INHIBITOR']);
let reducedMotion = false;

/**
 * The game coordinates the art covers, per axis.
 *
 * Per axis because a real render is not square and does not frame the Rift
 * symmetrically: this one is 2000×1670 with mountains and treeline around the
 * playable area, and the margin above the red base is nothing like the margin left of
 * the blue one. One shared span would put the lanes right on one axis and visibly
 * wrong on the other.
 *
 * Fitted against the art in /map-check.html, which draws these markers over it with
 * the four numbers as live inputs.
 */
const BOUNDS = {
  x: { min: -869, max: 15603 },
  y: { min: -446, max: 16078 },
};

const canvas = ref<HTMLCanvasElement | null>(null);
const art = ref<HTMLImageElement | null>(null);
const aspect = ref(1);

/**
 * The map, scaled and darkened once.
 *
 * Rescaling a 2000px render and compositing a wash over it sixty times a second is
 * most of a frame on a phone, and the background does not change between frames. It
 * is redrawn only when the art loads or the canvas is resized.
 */
let backdrop: HTMLCanvasElement | null = null;
let backdropKey = '';

function prepareBackdrop(w: number, h: number) {
  const image = art.value;
  if (!image?.complete || !image.naturalWidth) return null;

  const key = `${w}x${h}:${image.src}`;
  if (backdrop && backdropKey === key) return backdrop;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const off = document.createElement('canvas');
  off.width = Math.round(w * dpr);
  off.height = Math.round(h * dpr);

  const offCtx = off.getContext('2d');
  if (!offCtx) return null;

  offCtx.drawImage(image, 0, 0, off.width, off.height);
  // A full terrain render is busy and bright, and ten moving markers have to win
  // against it. The wash is heavier than it was over the flat minimap for that reason.
  offCtx.fillStyle = 'rgba(6, 10, 16, 0.5)';
  offCtx.fillRect(0, 0, off.width, off.height);

  backdrop = off;
  backdropKey = key;
  return off;
}
let frame = 0;

/**
 * Side colours, taken from the design tokens (--blue, --red) when the page has them.
 * The constants are the same values, for a canvas that draws before the stylesheet
 * is readable.
 */
const COLOURS = {
  BLUE: '#4a90ff',
  RED: '#f0505f',
  GROUND: '#04070d',
  FLASH: '#d8b064',
};

function readTokens() {
  try {
    const css = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    COLOURS.BLUE = read('--blue', COLOURS.BLUE);
    COLOURS.RED = read('--red', COLOURS.RED);
    COLOURS.GROUND = read('--bg-0', COLOURS.GROUND);
    COLOURS.FLASH = read('--gold-2', COLOURS.FLASH);
  } catch { /* keep the constants */ }
}

/** Blue's shape is round, red's is a diamond. `r` is the radius of a circle of equal weight. */
function sideShape(ctx: CanvasRenderingContext2D, team: string, x: number, y: number, r: number) {
  ctx.beginPath();
  if (team === 'RED') {
    const d = r * 1.25;
    ctx.moveTo(x, y - d);
    ctx.lineTo(x + d, y);
    ctx.lineTo(x, y + d);
    ctx.lineTo(x - d, y);
    ctx.closePath();
  } else {
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }
}

/**
 * Turret positions per lane, outer to inhibitor turret, then the inhibitor.
 *
 * Read from the engine's own table (packages/sim/src/map.js), so the structure that falls
 * on the map and the ring its event draws are always in the same place. Red's are blue's
 * rotated 180 degrees with top and bot swapped; the table explains why.
 */
function lanePoints(team: 'BLUE' | 'RED', lane: 'TOP' | 'MID' | 'BOT'): { x: number; y: number }[] {
  return (STRUCTURES as any)[team][lane];
}

const project = (w: number, h: number, x: number, y: number) => ({
  x: ((x - BOUNDS.x.min) / (BOUNDS.x.max - BOUNDS.x.min)) * w,
  y: h - ((y - BOUNDS.y.min) / (BOUNDS.y.max - BOUNDS.y.min)) * h,
});

function draw() {
  const el = canvas.value;
  if (!el) return;

  const ctx = el.getContext('2d');
  if (!ctx) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = el.clientWidth;
  const h = el.clientHeight;
  if (!w || !h) return;

  // Both axes, every frame. Guarding on width alone left the backing store at its
  // old height when the art loaded and changed the element's aspect ratio: the canvas
  // kept the pixels from the square frames below what the new, shorter drawing
  // cleared, and the map appeared twice.
  const needW = Math.round(w * dpr);
  const needH = Math.round(h * dpr);
  if (el.width !== needW || el.height !== needH) {
    el.width = needW;
    el.height = needH;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // The whole backing store, not the box we are about to draw into, so nothing from a
  // previous size can survive underneath.
  ctx.clearRect(0, 0, el.width, el.height);

  const p = (x: number, y: number) => project(w, h, x, y);
  // Marker sizes follow the short edge, so they stay the same size relative to the
  // map whatever shape the art is.
  const unit = Math.min(w, h);

  ctx.fillStyle = COLOURS.GROUND;
  ctx.fillRect(0, 0, w, h);

  const map = prepareBackdrop(w, h);
  if (map) ctx.drawImage(map, 0, 0, w, h);

  // Structures. Standing ones are team-coloured; fallen ones leave a socket behind,
  // because an empty space reads as "nothing was ever here".
  for (const team of ['BLUE', 'RED'] as const) {
    const built = props.structures?.[team];
    if (!built) continue;
    const colour = team === 'BLUE' ? COLOURS.BLUE : COLOURS.RED;

    for (const lane of ['TOP', 'MID', 'BOT'] as const) {
      const points = lanePoints(team, lane);

      points.slice(0, 3).forEach((point, i) => {
        const at = p(point.x, point.y);
        const alive = i < built[lane].towers;
        const r = unit * 0.0105;
        ctx.fillStyle = alive ? colour : 'rgba(8, 12, 20, 0.6)';
        ctx.strokeStyle = alive ? 'rgba(5, 8, 14, 0.8)' : 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 1;
        // Blue towers are squares, red ones the same square turned into a diamond.
        ctx.beginPath();
        if (team === 'RED') {
          const d = r * 1.3;
          ctx.moveTo(at.x, at.y - d);
          ctx.lineTo(at.x + d, at.y);
          ctx.lineTo(at.x, at.y + d);
          ctx.lineTo(at.x - d, at.y);
          ctx.closePath();
        } else {
          ctx.rect(at.x - r, at.y - r, r * 2, r * 2);
        }
        ctx.fill();
        ctx.stroke();
      });

      const inhib = p(points[3].x, points[3].y);
      ctx.beginPath();
      ctx.arc(inhib.x, inhib.y, unit * 0.011, 0, Math.PI * 2);
      ctx.fillStyle = built[lane].inhibitor ? colour : 'rgba(8, 12, 20, 0.6)';
      ctx.fill();
      ctx.strokeStyle = built[lane].inhibitor ? 'rgba(5, 8, 14, 0.8)' : 'rgba(255,255,255,0.12)';
      ctx.stroke();
    }

    // Nexus turrets: same shapes as the lane turrets, a touch smaller.
    const nexusTurrets: { x: number; y: number }[] = (STRUCTURES as any)[team].nexusTurrets;
    nexusTurrets.forEach((point, i) => {
      const at = p(point.x, point.y);
      const alive = i < (built.nexusTurrets ?? 2);
      const r = unit * 0.009;
      ctx.beginPath();
      if (team === 'RED') {
        const d = r * 1.3;
        ctx.moveTo(at.x, at.y - d);
        ctx.lineTo(at.x + d, at.y);
        ctx.lineTo(at.x, at.y + d);
        ctx.lineTo(at.x - d, at.y);
        ctx.closePath();
      } else {
        ctx.rect(at.x - r, at.y - r, r * 2, r * 2);
      }
      ctx.fillStyle = alive ? colour : 'rgba(8, 12, 20, 0.6)';
      ctx.fill();
      ctx.strokeStyle = alive ? 'rgba(5, 8, 14, 0.8)' : 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    const nexus = (STRUCTURES as any)[team].nexus;
    const base = p(nexus.x, nexus.y);
    ctx.beginPath();
    ctx.arc(base.x, base.y, unit * 0.024, 0, Math.PI * 2);
    ctx.strokeStyle = built.nexus ? colour : 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // The thing that just happened: a ring that opens out and fades over FLASH_MS of real
  // time, larger for the moments that matter. Held still under reduced motion.
  if (props.flash) {
    const at = p(props.flash.x, props.flash.y);
    const big = BIG_FLASH.has(props.flash.kind);
    const f = props.flash.at && !reducedMotion
      ? Math.min(1, Math.max(0, (performance.now() - props.flash.at) / FLASH_MS))
      : 0.35;
    ctx.beginPath();
    ctx.arc(at.x, at.y, unit * (big ? 0.035 + 0.05 * f : 0.03 + 0.03 * f), 0, Math.PI * 2);
    ctx.strokeStyle = COLOURS.FLASH;
    ctx.globalAlpha = 0.95 * (1 - f * 0.85);
    ctx.lineWidth = big ? 3 : 2;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Champions last, so nothing draws over them.
  for (const player of props.positions || []) {
    const at = p(player.pos.x, player.pos.y);
    const r = unit * 0.019;

    // Dead champions keep their shape at a third of the strength, rather than a
    // second, paler colour per side.
    sideShape(ctx, player.team, at.x, at.y, r);
    ctx.globalAlpha = player.alive ? 1 : 0.3;
    ctx.fillStyle = player.team === 'BLUE' ? COLOURS.BLUE : COLOURS.RED;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = player.alive ? 'rgba(5, 8, 14, 0.9)' : 'rgba(5, 8, 14, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = player.alive ? '#05080e' : 'rgba(233,238,250,0.45)';
    ctx.font = `800 ${Math.round(unit * 0.022)}px 'Mona Sans', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(player.slot[0], at.x, at.y + 0.5);
  }
}

/**
 * One draw on the next frame, however many things changed before it. Nothing keeps a
 * loop running: when the positions stop moving, so does the canvas.
 */
function schedule() {
  if (frame || typeof window === 'undefined') return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    draw();
  });
}

watch(() => [props.positions, props.structures, props.flash], schedule);

/**
 * While a ring is opening, keep drawing even if nothing else moves, so a replay paused on
 * the moment still shows the ring finish. Stops by itself when the ring is done.
 */
let ringFrame = 0;
function animateRing() {
  cancelAnimationFrame(ringFrame);
  const started = props.flash?.at;
  if (!started || reducedMotion || typeof window === 'undefined') return;
  const step = () => {
    draw();
    if (props.flash?.at === started && performance.now() - started < FLASH_MS) ringFrame = requestAnimationFrame(step);
  };
  ringFrame = requestAnimationFrame(step);
}
watch(() => props.flash?.at, animateRing);

/**
 * Whatever is in public/map, under any of the names a downloaded render arrives
 * with. Trying in order rather than demanding a .png means dropping in a new map is
 * a file copy and not a file copy plus a rename plus working out why the canvas went
 * black.
 */
const ART_SOURCES = ['/map/rift.jpg', '/map/rift.png', '/map/rift.jpeg', '/map/rift.webp'];

function loadArt(index = 0) {
  if (index >= ART_SOURCES.length) return;

  const image = new Image();
  image.src = ART_SOURCES[index];
  image.onload = () => {
    art.value = image;
    // The canvas takes the art's own aspect ratio rather than forcing it square,
    // because stretching a terrain render to a square is instantly visible.
    aspect.value = image.naturalWidth / image.naturalHeight;
    schedule();
  };
  image.onerror = () => loadArt(index + 1);
}

let resizer: ResizeObserver | null = null;

onMounted(() => {
  reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  readTokens();
  loadArt();
  schedule();
  // The slot letters are set in Mona Sans; once it has loaded, draw them again in it.
  document.fonts?.ready.then(schedule).catch(() => {});

  // The element changes size when the window does and when the art's aspect ratio
  // lands, and both need a redraw even though no prop moved.
  if (typeof ResizeObserver !== 'undefined' && canvas.value) {
    resizer = new ResizeObserver(schedule);
    resizer.observe(canvas.value);
  } else {
    window.addEventListener('resize', schedule);
  }
});

onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  cancelAnimationFrame(ringFrame);
  frame = 0;
  resizer?.disconnect();
  window.removeEventListener('resize', schedule);
});
</script>

<template>
  <canvas
    ref="canvas" class="rift" :style="{ aspectRatio: String(aspect) }"
    role="img" aria-label="Summoner's Rift, live positions. Blue side round, red side diamonds."
  />
</template>

<style scoped>
.rift {
  display: block;
  width: 100%;
  border: 1px solid var(--line-1);
  border-radius: var(--radius);
  background: var(--bg-0);
}
</style>
