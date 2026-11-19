<script setup lang="ts">
/**
 * Summoner's Rift: Riot's own minimap art, with ten dots and the structures still
 * standing drawn over it.
 *
 * Canvas 2D rather than SVG because this redraws every animation frame at up to 60×
 * speed, and ten DOM nodes moving at that rate is how you make a phone warm.
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

const props = defineProps<{
  positions: any[];
  structures: any;
  flash?: { x: number; y: number; kind: string } | null;
}>();

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

const COLOURS = {
  BLUE: '#4fc3f7',
  RED: '#ff6b66',
  BLUE_DIM: 'rgba(79, 195, 247, 0.3)',
  RED_DIM: 'rgba(255, 107, 102, 0.3)',
};

/**
 * Turret positions per lane, outer to inhibitor turret, then the inhibitor.
 *
 * Red's are blue's rotated 180 degrees about the centre — but that rotation sends the
 * left edge to the right edge, and the left edge is top lane while the right edge is
 * bot. So red's top turrets are the mirror of blue's *bot* anchors, and vice versa.
 * Mirroring lane-for-lane drew a fallen top turret on the wrong side of the map.
 */
function lanePoints(team: 'BLUE' | 'RED', lane: 'TOP' | 'MID' | 'BOT') {
  const anchors: Record<string, [number, number][]> = {
    TOP: [[980, 10440], [1180, 6430], [1180, 4400], [1050, 3700]],
    MID: [[5850, 6400], [5050, 4800], [3900, 3600], [3300, 3200]],
    BOT: [[10500, 1050], [6900, 1220], [4300, 1220], [3700, 1050]],
  };

  const MIRRORED = { TOP: 'BOT', BOT: 'TOP', MID: 'MID' } as const;
  const source = team === 'BLUE' ? anchors[lane] : anchors[MIRRORED[lane]];

  return source.map(([x, y]) =>
    team === 'BLUE' ? { x, y } : { x: 14870 - x, y: 14870 - y });
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

  if (el.width !== Math.round(w * dpr)) {
    el.width = Math.round(w * dpr);
    el.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const p = (x: number, y: number) => project(w, h, x, y);
  // Marker sizes follow the short edge, so they stay the same size relative to the
  // map whatever shape the art is.
  const unit = Math.min(w, h);

  ctx.fillStyle = '#060a10';
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
        ctx.fillRect(at.x - r, at.y - r, r * 2, r * 2);
        ctx.strokeRect(at.x - r, at.y - r, r * 2, r * 2);
      });

      const inhib = p(points[3].x, points[3].y);
      ctx.beginPath();
      ctx.arc(inhib.x, inhib.y, unit * 0.011, 0, Math.PI * 2);
      ctx.fillStyle = built[lane].inhibitor ? colour : 'rgba(8, 12, 20, 0.6)';
      ctx.fill();
      ctx.strokeStyle = built[lane].inhibitor ? 'rgba(5, 8, 14, 0.8)' : 'rgba(255,255,255,0.12)';
      ctx.stroke();
    }

    const base = team === 'BLUE' ? p(1500, 1500) : p(14870 - 1500, 14870 - 1500);
    ctx.beginPath();
    ctx.arc(base.x, base.y, unit * 0.024, 0, Math.PI * 2);
    ctx.strokeStyle = built.nexus ? colour : 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // The thing that just happened.
  if (props.flash) {
    const at = p(props.flash.x, props.flash.y);
    ctx.beginPath();
    ctx.arc(at.x, at.y, unit * 0.045, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(240, 194, 95, 0.8)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Champions last, so nothing draws over them.
  for (const player of props.positions || []) {
    const at = p(player.pos.x, player.pos.y);
    const r = unit * 0.019;

    ctx.beginPath();
    ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
    ctx.fillStyle = player.alive
      ? (player.team === 'BLUE' ? COLOURS.BLUE : COLOURS.RED)
      : (player.team === 'BLUE' ? COLOURS.BLUE_DIM : COLOURS.RED_DIM);
    ctx.fill();
    ctx.strokeStyle = player.alive ? 'rgba(5, 8, 14, 0.9)' : 'rgba(5, 8, 14, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = player.alive ? '#05080e' : 'rgba(233,238,250,0.45)';
    ctx.font = `700 ${Math.round(unit * 0.022)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(player.slot[0], at.x, at.y + 0.5);
  }
}

function loop() {
  draw();
  frame = requestAnimationFrame(loop);
}

/**
 * Whatever is in public/map, under any of the names a downloaded render arrives
 * with. Trying in order rather than demanding a .png means dropping in a new map is
 * a file copy and not a file copy plus a rename plus working out why the canvas went
 * black.
 */
const ART_SOURCES = ['/map/rift.png', '/map/rift.jpg', '/map/rift.jpeg', '/map/rift.webp'];

function loadArt(index = 0) {
  if (index >= ART_SOURCES.length) return;

  const image = new Image();
  image.src = ART_SOURCES[index];
  image.onload = () => {
    art.value = image;
    // The canvas takes the art's own aspect ratio rather than forcing it square,
    // because stretching a terrain render to a square is instantly visible.
    aspect.value = image.naturalWidth / image.naturalHeight;
    draw();
  };
  image.onerror = () => loadArt(index + 1);
}

onMounted(() => {
  loadArt();

  loop();
  window.addEventListener('resize', draw);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  window.removeEventListener('resize', draw);
});
</script>

<template>
  <canvas
    ref="canvas" class="rift" :style="{ aspectRatio: String(aspect) }"
    role="img" aria-label="Summoner's Rift, live positions"
  />
</template>

<style scoped>
.rift {
  display: block;
  width: 100%;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: #060a10;
}
</style>
