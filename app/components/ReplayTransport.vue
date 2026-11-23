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
  /**
   * Match seconds of the big moments (multikills, aces, Baron, Elder, the nexus). Played
   * faster than SLOW_TO, the clock eases down to it around each one and back up after.
   * Left out, the moments MatchWatch provides are used, so a parent that renders this in
   * MatchWatch's controls slot gets it for free.
   */
  moments?: number[];
}>(), {
  speeds: () => [1, 4, 8, 16, 60],
  initialSpeed: 60,
  autoplay: false,
  skip: true,
  moments: undefined,
});

const emit = defineEmits<{ 'update:clock': [t: number] }>();

const provided = inject<any>('matchMoments', null);
const momentTimes = computed<number[]>(() => props.moments ?? provided?.value ?? []);

/** The speed a big moment is watched at, and the game seconds either side of it. */
const SLOW_TO = 8;
const LEAD = 22;
const HOLD = 26;

const speed = ref(props.initialSpeed);
const playing = ref(false);
/** What the clock is actually running at: the chosen speed, eased down for a moment. */
const running = ref(props.initialSpeed);

let raf = 0;
let last = 0;
// Ticks advance a local copy so a parent that updates `clock` a frame late cannot stall us.
let now = props.clock;

const nearMoment = (t: number) => momentTimes.value.some((m) => t >= m - LEAD && t <= m + HOLD);
const slowed = computed(() => playing.value && speed.value > SLOW_TO && running.value < speed.value - 0.5);

function tick(stamp: number) {
  if (!playing.value) return;
  const dt = Math.min(0.25, (stamp - last) / 1000);
  last = stamp;
  const target = speed.value > SLOW_TO && nearMoment(now) ? SLOW_TO : speed.value;
  // Exponential ease, so the drop to 8x and the climb back read as a camera, not a cut.
  running.value += (target - running.value) * Math.min(1, dt * 5);
  now = Math.min(props.length, now + dt * running.value);
  emit('update:clock', now);
  if (now >= props.length) playing.value = false;
  else raf = requestAnimationFrame(tick);
}

watch(speed, (s) => { running.value = s; });

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

function seekBy(seconds: number) {
  const t = Math.max(0, Math.min(props.length, props.clock + seconds));
  now = t;
  emit('update:clock', t);
}

/**
 * Space plays and pauses, the arrows jump ten seconds. Not while someone is typing, and
 * space is left alone on a focused button, which already answers to it.
 */
function onKey(e: KeyboardEvent) {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
  const target = e.target as HTMLElement | null;
  const tag = target?.tagName;
  const isScrub = target?.classList?.contains('transport__scrub');
  if (!isScrub && (tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable
    || (tag === 'INPUT' && (target as HTMLInputElement).type !== 'range'))) return;

  if (e.key === ' ' || e.code === 'Space') {
    if (tag === 'BUTTON' || tag === 'A') return;
    e.preventDefault();
    toggle();
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    if (tag === 'INPUT' && !isScrub) return;
    e.preventDefault();
    seekBy(e.key === 'ArrowRight' ? 10 : -10);
  }
}

onMounted(() => {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (props.autoplay && !reduced) play();
  window.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  window.removeEventListener('keydown', onKey);
});

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
      <span v-if="slowed" class="transport__slow tnum" aria-hidden="true">{{ SLOW_TO }}× for the moment</span>
      <button v-if="skip && clock < length" class="btn btn--quiet transport__skip" type="button" @click="skipToEnd">
        Skip to result
      </button>
    </div>
    <p class="transport__keys">Space to play or pause, arrow keys to jump 10 seconds.</p>
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
.transport__slow {
  font-size: 11px;
  font-weight: 760;
  font-stretch: 112%;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--gold-1);
}
/* Shown to keyboard and screen-reader users, tucked away for everyone else. */
.transport__keys {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.transport:focus-within .transport__keys {
  position: static;
  width: auto;
  height: auto;
  clip: auto;
  margin: 0;
  font-size: 12px;
  color: var(--ink-3);
}
@media (max-width: 520px) {
  .transport__speed { flex: 1 1 100%; order: 3; }
  .transport__play { flex: 1 1 auto; }
}
</style>
