<script setup lang="ts">
/**
 * Play, pause, speed and a scrub bar for a match clock somebody is allowed to move.
 *
 * Owns the requestAnimationFrame loop and nothing else: the clock itself is the parent's
 * (`v-model:clock`), because MatchWatch reads it and the result's key moments write it. The
 * sandbox uses this from the first second; a finished duel uses it for a rewatch. A live duel
 * never mounts it, since a shared clock is the one thing that must not be movable.
 */

const props = withDefaults(defineProps<{
  clock: number;
  length: number;
  speeds?: number[];
  initialSpeed?: number;
  autoplay?: boolean;
  /** Show the "Skip to result" button. */
  skip?: boolean;
}>(), {
  speeds: () => [1, 2, 4, 60],
  initialSpeed: 60,
  autoplay: false,
  skip: true,
});

const emit = defineEmits<{ 'update:clock': [t: number] }>();

const speed = ref(props.initialSpeed);
const playing = ref(false);

let raf = 0;
let last = 0;
// Ticks advance a local copy so a parent that updates `clock` a frame late cannot stall us.
let now = props.clock;

function tick(stamp: number) {
  if (!playing.value) return;
  const dt = Math.min(0.25, (stamp - last) / 1000);
  last = stamp;
  now = Math.min(props.length, now + dt * speed.value);
  emit('update:clock', now);
  if (now >= props.length) playing.value = false;
  else raf = requestAnimationFrame(tick);
}

function play() {
  now = props.clock >= props.length ? 0 : props.clock;
  if (now === 0) emit('update:clock', 0);
  playing.value = true;
  last = performance.now();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
}

function pause() {
  playing.value = false;
  cancelAnimationFrame(raf);
}

const toggle = () => (playing.value ? pause() : play());

function skipToEnd() {
  pause();
  emit('update:clock', props.length);
}

function scrub(e: Event) {
  pause();
  emit('update:clock', Number((e.target as HTMLInputElement).value));
}

// A jump from outside (a key moment) while playing carries on from the new spot.
watch(() => props.clock, (t) => {
  if (Math.abs(t - now) > 1.5) now = t;
});

const clockText = (seconds: number) => {
  const t = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};
const scrubText = computed(() => `${clockText(props.clock)} of ${clockText(props.length)}`);
const fill = computed(() => `${Math.min(100, (props.clock / (props.length || 1)) * 100)}%`);

onMounted(() => {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (props.autoplay && !reduced) play();
});
onBeforeUnmount(() => cancelAnimationFrame(raf));

defineExpose({ play, pause, playing });
</script>

<template>
  <section class="transport" aria-label="Playback">
    <div class="transport__track">
      <span class="transport__time tnum">{{ clockText(clock) }}</span>
      <input
        class="transport__scrub" type="range" min="0" :max="length" step="1"
        :value="clock" aria-label="Match clock" :aria-valuetext="scrubText"
        :style="{ '--fill': fill }"
        @input="scrub"
      >
      <span class="transport__time transport__time--end tnum">{{ clockText(length) }}</span>
    </div>
    <div class="transport__row">
      <button
        class="btn btn--ghost transport__play" type="button"
        :aria-pressed="playing" data-sound="tap" @click="toggle"
      >
        <span class="transport__icon" :class="playing ? 'is-pause' : 'is-play'" aria-hidden="true" />
        {{ playing ? 'Pause' : clock >= length ? 'Watch again' : 'Play' }}
      </button>
      <div class="seg transport__speed" role="group" aria-label="Speed">
        <button
          v-for="s in speeds" :key="s" type="button"
          :aria-pressed="speed === s" @click="speed = s"
        >{{ s }}×</button>
      </div>
      <button v-if="skip && clock < length" class="btn btn--quiet transport__skip" type="button" @click="skipToEnd">
        Skip to result
      </button>
    </div>
  </section>
</template>

<style scoped>
.transport {
  display: grid;
  gap: 10px;
  padding: 12px 14px;
  background: var(--bg-2);
  border: 1px solid var(--line-1);
  border-radius: 6px;
}
.transport__track { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 12px; }
.transport__time { font-stretch: 80%; font-size: 15px; font-weight: 800; color: var(--ink-2); min-width: 4ch; }
.transport__time--end { color: var(--ink-3); text-align: right; }

.transport__scrub {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 44px;
  margin: 0;
  background: transparent;
  cursor: pointer;
}
.transport__scrub::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--gold-2) var(--fill, 0%), var(--bg-4) var(--fill, 0%));
}
.transport__scrub::-moz-range-track { height: 4px; border-radius: 2px; background: var(--bg-4); }
.transport__scrub::-moz-range-progress { height: 4px; border-radius: 2px; background: var(--gold-2); }
.transport__scrub::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  margin-top: -6px;
  background: var(--gold-1);
  border: 0;
  transform: rotate(45deg);
}
.transport__scrub::-moz-range-thumb { width: 14px; height: 14px; background: var(--gold-1); border: 0; border-radius: 0; transform: rotate(45deg); }
.transport__scrub:focus-visible { outline: 2px solid var(--gold-1); outline-offset: 2px; }

.transport__row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.transport__play { min-width: 140px; gap: 8px; }
.transport__icon { width: 10px; height: 12px; background: currentColor; }
.transport__icon.is-play { clip-path: polygon(0 0, 100% 50%, 0 100%); }
.transport__icon.is-pause { background: none; box-sizing: border-box; border-left: 3.5px solid currentColor; border-right: 3.5px solid currentColor; }
.transport__speed { flex: 0 1 260px; }
.transport__skip { margin-left: auto; }
@media (max-width: 520px) {
  .transport__speed { flex: 1 1 100%; order: 3; }
  .transport__play { flex: 1 1 auto; }
}
</style>
