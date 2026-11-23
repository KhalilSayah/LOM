<script setup lang="ts">
import { COVER_SIZE } from '@lom/card-engine';

/**
 * The shop's turntable. Packs stand on a ring: drag it, flick it, tap a side pack, use the
 * dots or the arrow keys. It runs a frame loop only while it is moving.
 */
const props = defineProps<{ packs: Array<{ key: string; name: string }>; modelValue: number }>();
const emit = defineEmits<{ (e: 'update:modelValue', index: number): void; (e: 'front'): void }>();

/** How far apart neighbours stand on the curve, whatever the number of packs. */
const SPREAD = 56;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const mod = (v: number, m: number) => ((v % m) + m) % m;

const root = ref<HTMLElement | null>(null);
const floor = ref<HTMLElement | null>(null);
const items: HTMLElement[] = [];
const setItem = (el: unknown, i: number) => { if (el) items[i] = el as HTMLElement; };

const count = computed(() => Math.max(1, props.packs.length));
const step = computed(() => 360 / count.value);

const ring = { a: props.modelValue * (360 / Math.max(1, props.packs.length)), to: props.modelValue * (360 / Math.max(1, props.packs.length)), v: 0, R: 200, dip: 8, leave: 0, held: false, sel: props.modelValue, pw: 180 };
let raf = 0;
let last = 0;
const reduced = () => typeof window !== 'undefined' && (window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'reduce');

function layout() {
  const N = count.value;
  const sel = mod(Math.round(ring.a / step.value), N);
  if (sel !== ring.sel) {
    ring.sel = sel;
    emit('update:modelValue', sel);
    playPackCue('turn');
  }
  if (floor.value) floor.value.style.transform = `translateZ(${-ring.R * 0.62}px) rotateX(80deg) rotateZ(${(ring.a * SPREAD) / step.value}deg)`;
  const width = root.value?.clientWidth ?? 0;
  const fade = 1 - ring.leave;
  items.forEach((el, i) => {
    if (!el) return;
    const rel = mod(i - ring.a / step.value + N / 2, N) - N / 2;
    const a = rel * SPREAD;
    const r = (a * Math.PI) / 180;
    const ab = Math.abs(a);
    const near = clamp(1 - ab / SPREAD, 0, 1);
    const x = Math.sin(r) * ring.R + Math.sign(a) * ring.leave * width * 0.62;
    const z = (Math.cos(r) - 1) * ring.R * 1.04;
    const y = (1 - Math.cos(r)) * ring.dip;
    const opacity = (ab < 74 ? 1 : Math.max(0, 1 - (ab - 74) / 32)) * (i === ring.sel ? 1 : fade);
    el.style.transform = `translate3d(${x}px, ${y}px, ${z}px) rotateY(${a * 0.82}deg) scale(${1 + near * 0.06})`;
    el.style.opacity = String(opacity);
    el.style.visibility = opacity < 0.02 ? 'hidden' : 'visible';
    el.style.zIndex = String(Math.round(Math.cos(r) * 100) + 100);
    const art = el.firstElementChild as HTMLElement | null;
    if (art) art.style.filter = `brightness(${(1 - clamp(ab / 100, 0, 1) * 0.6).toFixed(3)})`;
    const sheen = el.lastElementChild as HTMLElement | null;
    if (sheen) {
      sheen.style.setProperty('--sh', `${(rel * 42).toFixed(1)}%`);
      sheen.style.opacity = String(near * 0.75);
    }
  });
}

function frame(now: number) {
  const dt = Math.min(0.05, (now - (last || now)) / 1000);
  last = now;
  if (!ring.held) {
    const n = Math.max(1, Math.ceil(dt / 0.006));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      ring.v += (74 * (ring.to - ring.a) - 14 * ring.v) * h;
      ring.a += ring.v * h;
    }
    if (Math.abs(ring.to - ring.a) < 0.015 && Math.abs(ring.v) < 0.12) {
      ring.a = ring.to;
      ring.v = 0;
    }
  }
  layout();
  if (ring.held || ring.a !== ring.to || ring.v !== 0) raf = requestAnimationFrame(frame);
  else raf = 0;
}
function kick() {
  if (raf) return;
  last = 0;
  raf = requestAnimationFrame(frame);
}

function goTo(i: number) {
  const d = mod(i * step.value - ring.to + 180, 360) - 180;
  ring.to += d;
  if (reduced()) {
    ring.a = ring.to;
    ring.v = 0;
    layout();
    return;
  }
  kick();
}

watch(() => props.modelValue, (i) => {
  if (i !== mod(Math.round(ring.to / step.value), count.value)) goTo(i);
});

function measure() {
  const el = root.value;
  if (!el) return;
  const stage = el.querySelector('.ring') as HTMLElement | null;
  const w = el.clientWidth;
  const h = stage?.clientHeight ?? 0;
  if (!w || !h) return;
  ring.pw = Math.round(Math.min(w * 0.72, h * 0.6, 400));
  ring.R = ring.pw * 1.02;
  ring.dip = ring.pw * 0.075;
  el.style.setProperty('--rw', `${ring.pw / COVER_SIZE.packShare}px`);
  layout();
}

/* --- the finger -------------------------------------------------------------------- */
let spin: null | { id: number; x: number; last: number; t: number; v: number; moved: boolean } = null;

function down(e: PointerEvent) {
  spin = { id: e.pointerId, x: e.clientX, last: e.clientX, t: performance.now(), v: 0, moved: false };
  ring.held = true;
  ring.v = 0;
  try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
  kick();
}
function move(e: PointerEvent) {
  if (!spin || e.pointerId !== spin.id) return;
  if (Math.abs(e.clientX - spin.x) > 6) spin.moved = true;
  if (!spin.moved) return;
  const dx = e.clientX - spin.last;
  const now = performance.now();
  const dt = Math.max(4, now - spin.t) / 1000;
  const perPx = step.value / (ring.pw * 1.02);
  ring.a -= dx * perPx;
  spin.v += ((-dx * perPx) / dt - spin.v) * 0.38;
  spin.last = e.clientX;
  spin.t = now;
}
function up(e: PointerEvent) {
  if (!spin || e.pointerId !== spin.id) return;
  const was = spin;
  spin = null;
  ring.held = false;
  if (!was.moved) {
    ring.to = Math.round(ring.a / step.value) * step.value;
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const dx = e.clientX - (box.left + box.width / 2);
    const dy = e.clientY - (box.top + box.height / 2);
    if (Math.abs(dy) <= ring.pw * 0.86) {
      if (Math.abs(dx) > ring.pw * 0.56) goTo(mod(ring.sel + Math.sign(dx), count.value));
      else emit('front');
    }
    kick();
    return;
  }
  const stale = performance.now() - was.t > 90;
  const v = stale ? 0 : clamp(was.v, -620, 620);
  ring.v = v;
  ring.to = Math.round((ring.a + v * 0.17) / step.value) * step.value;
  if (reduced()) {
    ring.a = ring.to;
    ring.v = 0;
    layout();
    return;
  }
  kick();
}
function key(e: KeyboardEvent) {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  e.preventDefault();
  goTo(mod(mod(Math.round(ring.to / step.value), count.value) + (e.key === 'ArrowRight' ? 1 : -1), count.value));
}

/* --- for the page: where the front pack is, and getting out of its way ------------- */
function frontRect() {
  const el = items[ring.sel];
  if (!el) return null;
  const box = el.getBoundingClientRect();
  return { cx: box.left + box.width / 2, cy: box.top + box.height / 2, w: box.width * COVER_SIZE.packShare };
}
function leave() {
  return new Promise<void>((done) => {
    if (reduced()) { done(); return; }
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = clamp((now - t0) / 220, 0, 1);
      ring.leave = p * p * p;
      layout();
      if (p < 1) requestAnimationFrame(tick);
      else done();
    };
    requestAnimationFrame(tick);
  });
}
defineExpose({ frontRect, leave });

let observer: ResizeObserver | null = null;
onMounted(() => {
  measure();
  if (root.value && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(measure);
    observer.observe(root.value);
  }
});
onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  observer?.disconnect();
});
</script>

<template>
  <div ref="root" class="carousel">
    <div
      class="ring" role="group" aria-roledescription="carousel"
      aria-label="Packs. Use the left and right arrow keys to turn." tabindex="0"
      @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" @keydown="key"
    >
      <div class="ring__space">
        <div ref="floor" class="ring__floor" aria-hidden="true" />
        <div v-for="(p, i) in packs" :key="p.key" :ref="(el) => setItem(el, i)" class="rp">
          <div class="rp__art"><PackCover :kind="p.key" /></div>
          <i class="rp__sheen" aria-hidden="true" />
        </div>
      </div>
    </div>
    <div class="dots">
      <button
        v-for="(p, i) in packs" :key="p.key" type="button" data-sound="none"
        :aria-label="p.name" :aria-current="i === modelValue" @click="goTo(i)"
      ><i /></button>
    </div>
  </div>
</template>

<style scoped>
.carousel { --rw: 200px; position: relative; min-height: 0; height: 100%; display: grid; grid-template-rows: minmax(0, 1fr) auto; }
.ring { position: relative; min-height: 0; overflow: hidden; perspective: 980px; perspective-origin: 50% 40%; cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; outline-offset: -3px; }
.ring:active { cursor: grabbing; }
.ring__space { position: absolute; inset: 0; transform-style: preserve-3d; }
.ring__floor {
  position: absolute; left: 50%; top: calc(50% + var(--rw) * .6);
  width: calc(var(--rw) * 2.75); height: calc(var(--rw) * 2.75);
  margin: calc(var(--rw) * -1.375) 0 0 calc(var(--rw) * -1.375);
  border-radius: 50%; pointer-events: none; opacity: .32;
  background: repeating-conic-gradient(var(--gold-2) 0 .5deg, transparent .5deg 5deg);
  -webkit-mask-image: radial-gradient(closest-side, transparent 72%, #000 73%, #000 86%, transparent 87%, transparent 95%, #000 96%, #000 97%, transparent 98%);
  mask-image: radial-gradient(closest-side, transparent 72%, #000 73%, #000 86%, transparent 87%, transparent 95%, #000 96%, #000 97%, transparent 98%);
}
.rp {
  position: absolute; left: 50%; top: 50%; width: var(--rw); aspect-ratio: 580 / 850;
  margin-left: calc(var(--rw) / -2); margin-top: calc(var(--rw) * -.7328);
  transform-style: preserve-3d; will-change: transform, opacity;
}
.rp__art { width: 100%; height: 100%; }
.rp__sheen { position: absolute; inset: 6.2% 5.4%; overflow: hidden; pointer-events: none; mix-blend-mode: screen; }
.rp__sheen::before {
  content: ''; position: absolute; inset: -12% -70%;
  background: linear-gradient(106deg, transparent 39%, rgba(255, 255, 255, .05) 44%, rgba(255, 255, 255, .3) 50%, rgba(255, 255, 255, .05) 56%, transparent 61%);
  transform: translateX(var(--sh, 0%));
}
.dots { display: flex; justify-content: center; }
.dots button { position: relative; width: 30px; height: 20px; padding: 0; border: 0; background: none; cursor: pointer; display: grid; place-items: center; }
.dots button::after { content: ''; position: absolute; inset: -9px 0; }
.dots i { width: 7px; height: 7px; transform: rotate(45deg); box-shadow: inset 0 0 0 1px var(--ink-3); transition: background .14s linear, scale .18s ease; }
.dots button[aria-current='true'] i { background: var(--gold-2); box-shadow: none; scale: 1.45; }
@media (pointer: coarse) { .dots button { width: 36px; } }
</style>
