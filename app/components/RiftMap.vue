<script setup lang="ts">
/**
 * Summoner's Rift on a canvas: ten dots, the structures still standing, and the
 * objective pits.
 *
 * Canvas 2D rather than SVG because this redraws every animation frame at up to 60×
 * speed, and ten DOM nodes moving at that rate is how you make a phone warm.
 *
 * Rift coordinates are 0..14870 with y pointing up and blue in the bottom-left
 * corner, which is the orientation every League player already has in their head.
 * Canvas y points down, so every draw flips it — `project()` is the only place that
 * knows, and everything else can use map coordinates as given.
 */

const props = defineProps<{
  positions: any[];
  structures: any;
  flash?: { x: number; y: number; kind: string } | null;
}>();

const MAX = 14870;
const canvas = ref<HTMLCanvasElement | null>(null);
let frame = 0;

const COLOURS = {
  BLUE: '#5ec8f0',
  RED: '#ff6f6a',
  BLUE_DIM: 'rgba(94, 200, 240, 0.28)',
  RED_DIM: 'rgba(255, 111, 106, 0.28)',
};

const LANES: Array<[number, number][]> = [
  // Top lane: up the left edge, across the top.
  [[1500, 2600], [1500, 12600], [12400, 13300]],
  // Mid: corner to corner.
  [[2600, 2600], [12300, 12300]],
  // Bot: along the bottom, up the right edge.
  [[2600, 1500], [12600, 1500], [13300, 12400]],
];

/** Turret positions per lane, outer to inhibitor turret, then the inhibitor. */
function lanePoints(team: 'BLUE' | 'RED', lane: 'TOP' | 'MID' | 'BOT') {
  const anchors: Record<string, [number, number][]> = {
    TOP: [[1500, 10400], [1500, 7600], [1500, 4600], [1500, 3400]],
    MID: [[6100, 6100], [5000, 5000], [3900, 3900], [3100, 3100]],
    BOT: [[10400, 1500], [7600, 1500], [4600, 1500], [3400, 1500]],
  };

  return anchors[lane].map(([x, y]) =>
    team === 'BLUE' ? { x, y } : { x: MAX - x, y: MAX - y });
}

function project(ctx: CanvasRenderingContext2D, size: number, x: number, y: number) {
  return { x: (x / MAX) * size, y: size - (y / MAX) * size };
}

function draw() {
  const el = canvas.value;
  if (!el) return;

  const ctx = el.getContext('2d');
  if (!ctx) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const size = el.clientWidth;
  if (el.width !== size * dpr) {
    el.width = size * dpr;
    el.height = size * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const p = (x: number, y: number) => project(ctx, size, x, y);

  // Ground.
  ctx.fillStyle = '#0a1016';
  ctx.fillRect(0, 0, size, size);

  // River, corner to corner the other way.
  ctx.strokeStyle = 'rgba(90, 150, 190, 0.16)';
  ctx.lineWidth = size * 0.075;
  ctx.beginPath();
  const riverStart = p(1200, 13600);
  const riverEnd = p(13600, 1200);
  ctx.moveTo(riverStart.x, riverStart.y);
  ctx.lineTo(riverEnd.x, riverEnd.y);
  ctx.stroke();

  // Lanes.
  ctx.strokeStyle = 'rgba(190, 210, 235, 0.13)';
  ctx.lineWidth = size * 0.035;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const lane of LANES) {
    ctx.beginPath();
    lane.forEach(([x, y], i) => {
      const point = p(x, y);
      if (i === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.stroke();
  }

  // Objective pits.
  for (const [label, x, y] of [['D', 9800, 4400], ['B', 4900, 10100]] as const) {
    const pit = p(x, y);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.beginPath();
    ctx.arc(pit.x, pit.y, size * 0.045, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(233, 238, 250, 0.35)';
    ctx.font = `600 ${Math.round(size * 0.028)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, pit.x, pit.y);
  }

  // Structures.
  for (const team of ['BLUE', 'RED'] as const) {
    const built = props.structures?.[team];
    if (!built) continue;
    const colour = team === 'BLUE' ? COLOURS.BLUE : COLOURS.RED;

    for (const lane of ['TOP', 'MID', 'BOT'] as const) {
      const points = lanePoints(team, lane);
      const standing = built[lane].towers;

      points.slice(0, 3).forEach((point, i) => {
        const at = p(point.x, point.y);
        const alive = i < standing;
        ctx.fillStyle = alive ? colour : 'rgba(255,255,255,0.07)';
        const r = size * 0.011;
        ctx.fillRect(at.x - r, at.y - r, r * 2, r * 2);
      });

      const inhib = p(points[3].x, points[3].y);
      ctx.beginPath();
      ctx.arc(inhib.x, inhib.y, size * 0.011, 0, Math.PI * 2);
      ctx.fillStyle = built[lane].inhibitor ? colour : 'rgba(255,255,255,0.07)';
      ctx.fill();
    }

    // Nexus.
    const base = team === 'BLUE' ? p(1700, 1700) : p(MAX - 1700, MAX - 1700);
    ctx.beginPath();
    ctx.arc(base.x, base.y, size * 0.026, 0, Math.PI * 2);
    ctx.fillStyle = built.nexus ? colour : 'rgba(255,255,255,0.07)';
    ctx.globalAlpha = built.nexus ? 0.55 : 1;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // The thing that just happened.
  if (props.flash) {
    const at = p(props.flash.x, props.flash.y);
    ctx.beginPath();
    ctx.arc(at.x, at.y, size * 0.05, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(240, 194, 95, 0.75)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Champions last, so nothing draws over them.
  for (const player of props.positions || []) {
    const at = p(player.pos.x, player.pos.y);
    const r = size * 0.019;

    ctx.beginPath();
    ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
    ctx.fillStyle = player.alive
      ? (player.team === 'BLUE' ? COLOURS.BLUE : COLOURS.RED)
      : (player.team === 'BLUE' ? COLOURS.BLUE_DIM : COLOURS.RED_DIM);
    ctx.fill();

    if (player.alive) {
      ctx.strokeStyle = 'rgba(5, 8, 14, 0.85)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    ctx.fillStyle = player.alive ? '#05080e' : 'rgba(233,238,250,0.5)';
    ctx.font = `700 ${Math.round(size * 0.022)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(player.slot[0], at.x, at.y + 0.5);
  }
}

function loop() {
  draw();
  frame = requestAnimationFrame(loop);
}

onMounted(() => {
  loop();
  window.addEventListener('resize', draw);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  window.removeEventListener('resize', draw);
});
</script>

<template>
  <canvas ref="canvas" class="rift" role="img" aria-label="Summoner's Rift, live positions" />
</template>

<style scoped>
.rift {
  display: block;
  width: 100%;
  aspect-ratio: 1;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: #0a1016;
}
</style>
