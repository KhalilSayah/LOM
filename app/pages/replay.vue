<script setup lang="ts">
/**
 * The sandbox replay (docs/09 section 8).
 *
 * Nothing here counts, nothing is stored, and the opponent is a fixture. What it is for is
 * the thing docs/10 M6 gates on: watching a full game without reaching for the skip button.
 *
 * It renders through <MatchWatch>, which is the same component a duel's shared watch uses.
 * The difference between the two is entirely the clock — this page owns one and drives it
 * from requestAnimationFrame, with a scrub bar and speeds, because a sandbox is for poking
 * at. A duel's clock comes from the duel row and cannot be moved by either player, because
 * two people watching the same match is exactly the thing a movable clock breaks.
 *
 * Default speed is 60×, per docs/09: the whole game in about half a minute with the ticker
 * still readable. Skip to result is always visible, because forcing somebody to watch is how
 * you teach them to skip forever.
 */

const SPEEDS = [1, 2, 4, 60];

const data = ref<any>(null);
const loading = ref(true);
const error = ref('');

const clock = ref(0);
const speed = ref(60);
const playing = ref(false);
const reduced = ref(false);

let raf = 0;
let last = 0;

const result = computed(() => data.value?.result ?? null);
const length = computed(() => result.value?.gameLength ?? 0);

async function load(seed?: string) {
  loading.value = true;
  playing.value = false;
  try {
    data.value = await $fetch<any>('/api/sim/run', { query: seed ? { seed } : {} });
    clock.value = 0;
    error.value = '';
    if (!reduced.value) start();
  } catch (e: any) {
    error.value = e?.statusMessage || e?.data?.statusMessage || 'Could not run a match.';
  } finally {
    loading.value = false;
  }
}

function tick(now: number) {
  if (!playing.value) return;
  const dt = (now - last) / 1000;
  last = now;

  clock.value = Math.min(length.value, clock.value + dt * speed.value);
  if (clock.value >= length.value) playing.value = false;
  else raf = requestAnimationFrame(tick);
}

function start() {
  if (clock.value >= length.value) clock.value = 0;
  playing.value = true;
  last = performance.now();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
}

function pause() {
  playing.value = false;
  cancelAnimationFrame(raf);
}

const toggle = () => (playing.value ? pause() : start());

function skipToResult() {
  pause();
  clock.value = length.value;
}

function scrub(e: Event) {
  pause();
  clock.value = Number((e.target as HTMLInputElement).value);
}

onMounted(() => {
  reduced.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  load();
});

onBeforeUnmount(() => cancelAnimationFrame(raf));

useHead({ title: 'Replay — LOM' });
</script>

<template>
  <main class="page page--wide">
    <header class="topbar">
      <h1>Replay</h1>
      <span v-if="data" class="topbar__meta">{{ data.seed }}</span>
    </header>

    <p v-if="error" class="notice notice--bad">{{ error }}</p>

    <div v-if="loading" class="skeleton map-skeleton" />

    <template v-else-if="result">
      <p v-if="data.source === 'FIXTURE' && data.missing.length" class="notice">
        Fielding a stand-in five: your roster is missing
        {{ data.missing.join(', ') }}. <NuxtLink to="/roster">Fill it</NuxtLink> and the
        next match runs with your cards.
      </p>

      <MatchWatch
        :result="result"
        :clock="clock"
        :blue-name="data.blueName"
        :red-name="data.redName"
        :show-result="clock >= length"
      />

      <!-- Transport. A sandbox gets one; a duel does not. -->
      <section class="transport">
        <input
          class="transport__scrub" type="range" min="0" :max="length" step="1"
          :value="clock" aria-label="Scrub" @input="scrub"
        >
        <div class="transport__row">
          <button class="btn" type="button" @click="toggle">
            {{ playing ? 'Pause' : clock >= length ? 'Replay' : 'Play' }}
          </button>
          <div class="chips">
            <button
              v-for="s in SPEEDS" :key="s" class="chip"
              :aria-pressed="speed === s" @click="speed = s"
            >{{ s }}×</button>
          </div>
          <button class="btn btn--quiet" type="button" @click="skipToResult">Skip to result</button>
        </div>
      </section>

      <div class="again">
        <button class="btn btn--ghost" type="button" @click="load()">Run another match</button>
        <NuxtLink class="btn" to="/duels">Battle someone instead</NuxtLink>
      </div>
    </template>
  </main>
</template>

<style scoped>
.map-skeleton { aspect-ratio: 1; border-radius: var(--radius); }

.transport { margin-top: 14px; display: grid; gap: 10px; }
.transport__scrub { width: 100%; accent-color: var(--accent); }
.transport__row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }

.again {
  margin-top: 16px;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: center;
}
</style>
