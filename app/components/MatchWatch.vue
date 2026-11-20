<script setup lang="ts">
import { buildTracks, positionsAt, structuresAt, scoreAt } from '~~/packages/sim/src/replay.js';

/**
 * A match, being watched.
 *
 * Deliberately has no clock of its own. The parent passes one in, and that is the whole
 * reason this is a component rather than a page: the sandbox replay drives it from a local
 * requestAnimationFrame, and a duel drives it from `watch_start_at` on the duel row — one
 * instant written once, which both players compute the same number from. Two people watching
 * the same match is not a feature you can add to a player with its own clock; it is the
 * absence of one.
 *
 * Everything on screen is a pure function of that clock: positions, structures, score,
 * ticker. Nothing accumulates, so a client that was backgrounded for ten seconds and comes
 * back is instantly correct rather than ten seconds behind, which is the other thing a
 * self-driving player cannot do.
 */

const props = defineProps<{
  result: any;
  /** Match seconds. The parent owns this. */
  clock: number;
  blueName: string;
  redName: string;
  /** Which side is the viewer's, so their own team can be named as theirs. */
  mySide?: 'BLUE' | 'RED' | null;
  /** The box score and winner. Held back until the match has actually finished. */
  showResult?: boolean;
}>();

const length = computed(() => props.result?.gameLength ?? 0);

const tracks = computed(() =>
  (props.result ? buildTracks(props.result, props.result.boxScore) : null));
const positions = computed(() => (tracks.value ? positionsAt(tracks.value, props.clock) : []));
const structures = computed(() => (props.result ? structuresAt(props.result, props.clock) : null));
const score = computed(() => (props.result ? scoreAt(props.result, props.clock) : null));

/** Everything that has happened by now, newest first — the auto-scrolling ticker. */
const ticker = computed(() => {
  if (!props.result) return [];
  return props.result.events
    .filter((e: any) => e.t <= props.clock && e.narration)
    .slice(-60)
    .reverse();
});

const recent = computed(() => {
  if (!props.result) return null;
  const hit = [...props.result.events]
    .reverse()
    .find((e: any) => e.pos && e.t <= props.clock && props.clock - e.t < 3);
  return hit ? { ...hit.pos, kind: hit.type } : null;
});

const clockText = (t: number) =>
  `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/** The gold-diff sparkline, as an SVG path over the timeline samples. */
const sparkline = computed(() => {
  const samples = props.result?.timeline ?? [];
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

const won = computed(() =>
  props.mySide ? props.result?.winner === props.mySide : null);
</script>

<template>
  <div v-if="result && score" class="watch">
    <!-- Scoreboard -->
    <section class="board">
      <div class="board__side">
        <p class="board__name" :class="{ 'is-you': mySide === 'BLUE' }">
          {{ blueName }}<span v-if="mySide === 'BLUE'" class="board__you">you</span>
        </p>
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
        <p class="board__name" :class="{ 'is-you': mySide === 'RED' }">
          <span v-if="mySide === 'RED'" class="board__you">you</span>{{ redName }}
        </p>
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
        :x1="(clock / (length || 1)) * 100" y1="0" :x2="(clock / (length || 1)) * 100" y2="40"
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

    <section v-if="showResult" class="panel result">
      <p class="eyebrow">Result</p>
      <p v-if="won !== null" class="result__verdict" :class="won ? 'is-won' : 'is-lost'">
        {{ won ? 'You won' : 'You lost' }}
      </p>
      <p class="result__line">
        <strong :class="result.winner === 'BLUE' ? 'is-blue' : 'is-red'">
          {{ result.winner === 'BLUE' ? blueName : redName }}
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
  </div>
</template>

<style scoped>
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
.board__name.is-you { color: var(--ink); }
.board__you {
  font-size: 9px;
  letter-spacing: 0.1em;
  padding: 1px 5px;
  margin: 0 5px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.09);
  color: var(--ink-dim);
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
.spark__line { fill: none; stroke: var(--gold-2); stroke-width: 1.2; vector-effect: non-scaling-stroke; }
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

.result { margin-top: 14px; }
.result__verdict {
  font-family: var(--font-display);
  font-size: 26px;
  font-weight: 700;
  margin: 4px 0 2px;
}
.result__verdict.is-won { color: var(--good, #7df0dc); }
.result__verdict.is-lost { color: #ff8a8a; }
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
</style>
