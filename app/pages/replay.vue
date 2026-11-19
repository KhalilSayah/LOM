<script setup lang="ts">
import { buildTracks, positionsAt, structuresAt, scoreAt } from '~~/packages/sim/src/replay.js';

/**
 * The replay: a match you can watch (docs/09 section 8).
 *
 * A sandbox for now — nothing here counts, nothing is stored, and the opponent is a
 * fixture. What it is really for is the thing docs/10 M6 gates on: watching a full
 * game without reaching for the skip button. If that fails here it will fail with
 * fixtures too, and finding out now costs an afternoon rather than a milestone.
 *
 * Default speed is 60×, per docs/09: the whole game in about half a minute, with the
 * ticker still readable. Skip to result is always visible, because forcing someone
 * to watch is how you teach them to skip forever.
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

const tracks = computed(() => (result.value ? buildTracks(result.value, result.value.boxScore) : null));
const positions = computed(() => (tracks.value ? positionsAt(tracks.value, clock.value) : []));
const structures = computed(() => (result.value ? structuresAt(result.value, clock.value) : null));
const score = computed(() => (result.value ? scoreAt(result.value, clock.value) : null));

/** Everything that has happened by now, newest first — the auto-scrolling ticker. */
const ticker = computed(() => {
  if (!result.value) return [];
  return result.value.events
    .filter((e: any) => e.t <= clock.value && e.narration)
    .slice(-60)
    .reverse();
});

const recent = computed(() => {
  if (!result.value) return null;
  const hit = [...result.value.events]
    .reverse()
    .find((e: any) => e.pos && e.t <= clock.value && clock.value - e.t < 3);
  return hit ? { ...hit.pos, kind: hit.type } : null;
});

const clockText = (t: number) =>
  `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/** The gold-diff sparkline, as an SVG path over the timeline samples. */
const sparkline = computed(() => {
  const samples = result.value?.timeline ?? [];
  if (samples.length < 2) return { path: '', zero: 20 };

  const peak = Math.max(2000, ...samples.map((s: any) => Math.abs(s.goldDiff)));
  const points = samples.map((s: any, i: number) => {
    const x = (i / (samples.length - 1)) * 100;
    const y = 20 - (s.goldDiff / peak) * 18;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  });

  return { path: points.join(' '), zero: 20 };
});

const liveGold = computed(() => score.value?.goldDiff ?? 0);

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

      <!-- Scoreboard -->
      <section class="board">
        <div class="board__side">
          <p class="board__name">{{ data.blueName }}</p>
          <p class="board__k tnum is-blue">{{ score.kills.BLUE }}</p>
          <p class="board__buffs">
            <span v-for="b in score.buffs.BLUE" :key="b" class="buff">{{ b.toLowerCase() }}</span>
            <span v-if="score.dragons.BLUE" class="buff buff--quiet">{{ score.dragons.BLUE }} drake</span>
          </p>
        </div>

        <div class="board__clock">
          <p class="board__time tnum">{{ clockText(clock) }}</p>
          <p class="board__gold tnum" :class="liveGold >= 0 ? 'is-blue' : 'is-red'">
            {{ liveGold >= 0 ? '+' : '' }}{{ (liveGold / 1000).toFixed(1) }}k
          </p>
        </div>

        <div class="board__side board__side--right">
          <p class="board__name">{{ data.redName }}</p>
          <p class="board__k tnum is-red">{{ score.kills.RED }}</p>
          <p class="board__buffs">
            <span v-if="score.dragons.RED" class="buff buff--quiet">{{ score.dragons.RED }} drake</span>
            <span v-for="b in score.buffs.RED" :key="b" class="buff">{{ b.toLowerCase() }}</span>
          </p>
        </div>
      </section>

      <svg class="spark" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" :y1="sparkline.zero" x2="100" :y2="sparkline.zero" class="spark__zero" />
        <path :d="sparkline.path" class="spark__line" />
        <line
          :x1="(clock / length) * 100" y1="0" :x2="(clock / length) * 100" y2="40"
          class="spark__head"
        />
      </svg>

      <div class="stage">
        <RiftMap :positions="positions" :structures="structures" :flash="recent" />

        <ul class="ticker" aria-live="polite">
          <li v-for="event in ticker" :key="event.seq" :class="`is-${(event.team || '').toLowerCase()}`">
            <span class="ticker__t tnum">{{ clockText(event.t) }}</span>
            <span>{{ event.narration }}</span>
          </li>
        </ul>
      </div>

      <!-- Transport -->
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

      <!-- Result -->
      <section v-if="clock >= length" class="panel result">
        <p class="eyebrow">Result</p>
        <p class="result__line">
          <strong :class="result.winner === 'BLUE' ? 'is-blue' : 'is-red'">
            {{ result.winner === 'BLUE' ? data.blueName : data.redName }}
          </strong>
          wins in {{ clockText(result.gameLength) }}
          <span class="faint">· {{ result.endReason.toLowerCase().replace('_', ' ') }}</span>
        </p>

        <table class="box">
          <thead>
            <tr><th>player</th><th>champion</th><th>K/D/A</th><th>CS</th><th>dmg</th><th>grade</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in result.boxScore" :key="row.pid" :class="`is-${row.team.toLowerCase()}`">
              <td>{{ row.name }}</td>
              <td class="faint">{{ row.champion || '—' }}</td>
              <td class="tnum">{{ row.kills }}/{{ row.deaths }}/{{ row.assists }}</td>
              <td class="tnum">{{ row.cs }}</td>
              <td class="tnum">{{ Math.round(row.damageShare * 100) }}%</td>
              <td class="box__grade">{{ row.grade }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <div class="again">
        <button class="btn btn--ghost" type="button" @click="load()">Run another match</button>
      </div>
    </template>
  </main>
</template>

<style scoped>
.map-skeleton { aspect-ratio: 1; border-radius: var(--radius); }

.board { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 10px; margin-bottom: 6px; }
.board__name {
  font-family: var(--font-label);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ink-dim);
  margin: 0;
}
.board__k { font-family: var(--font-display); font-size: 32px; font-weight: 700; margin: 2px 0 0; }
.board__side--right { text-align: right; }
.board__clock { text-align: center; }
.board__time { font-family: var(--font-display); font-size: 22px; font-weight: 700; margin: 0; }
.board__gold { font-size: 13px; font-weight: 700; margin: 2px 0 0; }
.board__buffs { display: flex; flex-wrap: wrap; gap: 5px; margin: 4px 0 0; }
.board__side--right .board__buffs { justify-content: flex-end; }
.buff {
  font-family: var(--font-label);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(240, 194, 95, 0.16);
  color: var(--warn);
}
.buff--quiet { background: rgba(255, 255, 255, 0.06); color: var(--ink-dim); }

.is-blue { color: #5ec8f0; }
.is-red { color: #ff6f6a; }

.spark { width: 100%; height: 42px; margin-bottom: 8px; }
.spark__zero { stroke: rgba(255, 255, 255, 0.12); stroke-width: 0.5; }
.spark__line { fill: none; stroke: var(--accent); stroke-width: 1.2; vector-effect: non-scaling-stroke; }
.spark__head { stroke: rgba(255, 255, 255, 0.35); stroke-width: 0.5; }

.stage { display: grid; gap: 12px; }
@media (min-width: 820px) {
  .stage { grid-template-columns: minmax(0, 1fr) 300px; align-items: start; }
}

.ticker {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
  max-height: 300px;
  overflow-y: auto;
  font-size: 13.5px;
  line-height: 1.45;
}
.ticker li { display: grid; grid-template-columns: 46px minmax(0, 1fr); gap: 8px; }
.ticker__t { color: var(--ink-faint); font-size: 12.5px; }
.ticker li.is-blue span:last-child { color: #a9dcf2; }
.ticker li.is-red span:last-child { color: #ffb3af; }

.transport { margin-top: 14px; display: grid; gap: 10px; }
.transport__scrub { width: 100%; accent-color: var(--accent); }
.transport__row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }

.result { margin-top: 14px; }
.result__line { font-size: 15px; margin: 6px 0 12px; }
.box { width: 100%; border-collapse: collapse; font-size: 13px; }
.box th {
  text-align: left;
  font-family: var(--font-label);
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ink-faint);
  font-weight: 600;
  padding-bottom: 6px;
}
.box td { padding: 4px 0; border-top: 1px solid var(--line); }
.box tr.is-blue td:first-child { color: #a9dcf2; }
.box tr.is-red td:first-child { color: #ffb3af; }
.box__grade { font-family: var(--font-display); font-weight: 700; }

.again { margin-top: 16px; text-align: center; }
</style>
