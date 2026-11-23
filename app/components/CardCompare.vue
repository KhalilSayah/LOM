<script setup lang="ts">
/**
 * The two pinned cards, side by side: one radar with both shapes on it, the six numbers
 * with the gap between them, and the champion pools split into what they share and what
 * only one of them brings.
 *
 * The two cards are told apart by colour AND line: the first is gold and solid, the second
 * blue and dashed, and every number is labelled by name as well, so nothing here rests on
 * colour alone.
 */
const { pins, open, remove } = useCompare();

const STATS: Array<[string, string]> = [
  ['laning', 'Lane'], ['teamfight', 'Teamfight'], ['mechanics', 'Mechanics'],
  ['macro', 'Macro'], ['vision', 'Vision'], ['consistency', 'Consistency'],
];
const share = (v: number) => Math.max(0, Math.min(1, (v - 40) / 59));

const a = computed(() => pins.value[0] ?? null);
const b = computed(() => pins.value[1] ?? null);
const ready = computed(() => open.value && !!a.value && !!b.value);

const label = (p: any) => `${p.card.playerName} ${p.card.season ?? ''}`.trim();
const whose = (p: any) => (p.owner ? `${p.owner}'s` : 'Yours');
const stat = (p: any, k: string) => Number(p?.card?.subStats?.[k] ?? 0);

const pt = (i: number, r: number) => {
  const ang = (-90 + i * 60) * (Math.PI / 180);
  return `${(100 + Math.cos(ang) * r).toFixed(1)},${(100 + Math.sin(ang) * r).toFixed(1)}`;
};
const R = 70;
const radar = computed(() => ({
  outer: STATS.map((_, i) => pt(i, R)).join(' '),
  inner: STATS.map((_, i) => pt(i, R / 2)).join(' '),
  axes: STATS.map((_, i) => pt(i, R).split(',')),
  labels: STATS.map(([, l], i) => {
    const [x, y] = pt(i, R + 16).split(',').map(Number);
    return { l, x, y };
  }),
  a: a.value ? STATS.map(([k], i) => pt(i, R * share(stat(a.value, k)))).join(' ') : '',
  b: b.value ? STATS.map(([k], i) => pt(i, R * share(stat(b.value, k)))).join(' ') : '',
}));

const rows = computed(() => STATS.map(([k, l]) => {
  const va = stat(a.value, k);
  const vb = stat(b.value, k);
  return { k, l, va, vb, diff: va - vb };
}));

const ovrDiff = computed(() => (a.value && b.value ? a.value.card.ovr - b.value.card.ovr : 0));

/** Champions both cards play, then the ones only one of them brings. */
const pools = computed(() => {
  const pa = new Map<string, any>((a.value?.card?.championPool || []).map((c: any) => [c.key || c.champion, c]));
  const pb = new Map<string, any>((b.value?.card?.championPool || []).map((c: any) => [c.key || c.champion, c]));
  const shared = [...pa.keys()].filter((k) => pb.has(k))
    .map((k) => ({ key: k, name: pa.get(k).champion, ma: pa.get(k).mastery, mb: pb.get(k).mastery }))
    .sort((x, y) => (y.ma + y.mb) - (x.ma + x.mb));
  const onlyA = [...pa.values()].filter((c) => !pb.has(c.key || c.champion)).slice(0, 8);
  const onlyB = [...pb.values()].filter((c) => !pa.has(c.key || c.champion)).slice(0, 8);
  return { shared, onlyA, onlyB };
});

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

const closeBtn = ref<HTMLButtonElement | null>(null);
function close() { open.value = false; }
function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && ready.value) close(); }

watch(ready, async (now) => {
  if (!now) return;
  await nextTick();
  closeBtn.value?.focus();
});
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <Teleport to="body">
    <div v-if="ready && a && b" class="cmp-backdrop" @click.self="close">
      <section class="cmp" role="dialog" aria-modal="true" aria-labelledby="cmp-title">
        <header class="cmp__head">
          <h2 id="cmp-title">Compare</h2>
          <button ref="closeBtn" class="icon-btn" type="button" aria-label="Close compare" data-sound="back" @click="close">
            <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </header>

        <div class="cmp__cards">
          <div v-for="(p, i) in [a, b]" :key="p.id" class="cmp__side" :class="i === 0 ? 'is-a' : 'is-b'">
            <div class="cmp__card"><LomCard :card="p.card" compact :interactive="false" /></div>
            <p class="cmp__name"><span class="cmp__key" aria-hidden="true" />{{ label(p) }}</p>
            <p class="cmp__who faint">{{ whose(p) }}<template v-if="p.level && p.level > 1"> · Lv {{ p.level }}</template></p>
            <button class="cmp__drop" type="button" :aria-label="`Unpin ${label(p)}`" @click="remove(p.id)">Unpin</button>
          </div>
        </div>

        <p class="cmp__ovr">
          <span class="num">{{ a.card.ovr }}</span>
          <span class="cmp__vs">
            <template v-if="ovrDiff === 0">Same overall</template>
            <template v-else>{{ ovrDiff > 0 ? label(a) : label(b) }} by {{ Math.abs(ovrDiff) }}</template>
          </span>
          <span class="num">{{ b.card.ovr }}</span>
        </p>

        <svg viewBox="0 0 200 200" class="cmp__radar" role="img" :aria-label="`Sub-stats. ${rows.map((r) => `${r.l}: ${label(a)} ${r.va}, ${label(b)} ${r.vb}`).join('. ')}`">
          <polygon :points="radar.outer" fill="none" stroke="rgba(200,215,255,.16)" />
          <polygon :points="radar.inner" fill="none" stroke="rgba(200,215,255,.1)" />
          <line v-for="(ax, i) in radar.axes" :key="i" x1="100" y1="100" :x2="ax[0]" :y2="ax[1]" stroke="rgba(200,215,255,.07)" />
          <polygon :points="radar.a" fill="rgba(216,176,100,.16)" stroke="#d8b064" stroke-width="1.6" />
          <polygon :points="radar.b" fill="rgba(156,195,255,.1)" stroke="#9cc3ff" stroke-width="1.6" stroke-dasharray="4 3" />
          <text v-for="t in radar.labels" :key="t.l" :x="t.x" :y="t.y" text-anchor="middle" dominant-baseline="middle" class="cmp__axis">{{ t.l }}</text>
        </svg>

        <table class="cmp__stats">
          <thead>
            <tr><th scope="col">Stat</th><th scope="col">{{ a.card.playerName }}</th><th scope="col">{{ b.card.playerName }}</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.k">
              <th scope="row">{{ r.l }}</th>
              <td :class="{ 'is-up': r.diff > 0 }"><b class="tnum">{{ r.va }}</b><small v-if="r.diff > 0">{{ signed(r.diff) }}</small></td>
              <td :class="{ 'is-up': r.diff < 0 }"><b class="tnum">{{ r.vb }}</b><small v-if="r.diff < 0">{{ signed(-r.diff) }}</small></td>
            </tr>
          </tbody>
        </table>

        <section class="cmp__pools">
          <h3 class="label">Both play</h3>
          <ul v-if="pools.shared.length" class="cmp__shared">
            <li v-for="c in pools.shared" :key="c.key">
              <span>{{ c.name }}</span>
              <b class="tnum" :class="{ 'is-up': c.ma > c.mb }">{{ c.ma }}</b>
              <b class="tnum" :class="{ 'is-up': c.mb > c.ma }">{{ c.mb }}</b>
            </li>
          </ul>
          <p v-else class="faint cmp__none">No champion in common.</p>

          <div class="cmp__only">
            <div>
              <h3 class="label">Only {{ a.card.playerName }}</h3>
              <p class="cmp__list">{{ pools.onlyA.map((c) => `${c.champion} ${c.mastery}`).join(' · ') || '—' }}</p>
            </div>
            <div>
              <h3 class="label">Only {{ b.card.playerName }}</h3>
              <p class="cmp__list">{{ pools.onlyB.map((c) => `${c.champion} ${c.mastery}`).join(' · ') || '—' }}</p>
            </div>
          </div>
        </section>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.cmp-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  align-items: end;
  justify-items: center;
  background: rgba(2, 4, 8, 0.72);
}
.cmp {
  width: min(100%, 720px);
  max-height: 92vh;
  max-height: 92dvh;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 14px 16px calc(24px + env(safe-area-inset-bottom, 0px));
  background: var(--bg-1);
  border-top: 1px solid var(--line-2);
  border-radius: 6px 6px 0 0;
}
@media (min-width: 760px) {
  .cmp-backdrop { align-items: center; }
  .cmp { border: 1px solid var(--line-2); border-radius: var(--radius); padding: 18px 24px 28px; }
}

.cmp__head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.cmp__head h2 { font-stretch: 92%; font-weight: 760; font-size: 20px; }

.cmp__cards { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.cmp__side { display: grid; justify-items: center; gap: 4px; text-align: center; min-width: 0; }
.cmp__card { width: min(100%, 150px); }
.cmp__name { display: flex; align-items: center; gap: 7px; margin: 6px 0 0; font-weight: 720; font-size: 14px; }
.cmp__who { margin: 0; font-size: 12px; }
.cmp__key { flex: none; width: 18px; height: 0; border-top: 2px solid var(--gold-2); }
.is-b .cmp__key { border-top: 2px dashed var(--blue-2); }
.cmp__drop { appearance: none; min-height: 44px; padding: 0 10px; border: 0; background: none; color: var(--ink-3); font: inherit; font-size: 12px; cursor: pointer; }
.cmp__drop:hover { color: var(--ink-1); }

.cmp__ovr { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 12px; margin: 6px 0 0; padding: 10px 0; border-block: 1px solid var(--line-1); }
.cmp__ovr .num { font-size: 34px; }
.cmp__vs { text-align: center; font-size: 13px; color: var(--ink-2); }

.cmp__radar { display: block; width: min(100%, 280px); margin: 8px auto 0; overflow: visible; }
.cmp__axis { font-size: 8.5px; fill: var(--ink-3); font-family: var(--f); }

.cmp__stats { width: 100%; margin-top: 10px; border-collapse: collapse; font-size: 13.5px; }
.cmp__stats th, .cmp__stats td { padding: 7px 4px; border-bottom: 1px solid var(--line-1); text-align: right; }
.cmp__stats th:first-child { text-align: left; font-weight: 600; color: var(--ink-2); }
.cmp__stats thead th { font-size: 12px; font-weight: 650; color: var(--ink-3); }
.cmp__stats td b { font-weight: 760; }
.cmp__stats td small { margin-left: 6px; font-size: 11.5px; color: var(--gold-1); }
.cmp__stats td:not(.is-up) b { color: var(--ink-2); font-weight: 600; }

.cmp__pools { margin-top: 18px; display: grid; gap: 8px; }
.cmp__pools h3 { margin: 0; }
.cmp__shared { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.cmp__shared li { display: grid; grid-template-columns: minmax(0, 1fr) 40px 40px; gap: 8px; padding: 5px 0; font-size: 13.5px; border-bottom: 1px solid var(--line-1); }
.cmp__shared b { text-align: right; font-weight: 600; color: var(--ink-2); }
.cmp__shared b.is-up { font-weight: 780; color: var(--ink-1); }
.cmp__none { margin: 0; font-size: 13px; }
.cmp__only { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 6px; }
.cmp__list { margin: 4px 0 0; font-size: 13px; line-height: 1.5; color: var(--ink-2); }
</style>
