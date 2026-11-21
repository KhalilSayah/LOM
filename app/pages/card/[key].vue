<script setup lang="ts">
import { toCard } from '~~/shared/cardShape';

const route = useRoute();
const supabase = useSupabaseClient();
const user = useSupabaseUser();
const managerId = useManagerId();

const held = ref<any>(null);
const loading = ref(true);
const missing = ref(false);

const SELECT = `
  id, level, xp, copies, acquired_at,
  card:card_definitions!inner (
    card_key, player_name, season, team, region, role, ovr, rarity,
    sub_stats, accolades, season_summary, provenance, art_champion_key, art_focus,
    pool:card_champion_pool ( champion_key, champion_name, games, winrate, mastery, slot )
  )
`;

const DDRAGON = 'https://ddragon.leagueoflegends.com/cdn/16.22.1/img/champion';

const ACCOLADES: Record<string, string> = {
  WORLDS_WINNER: 'World champion',
  INTERNATIONAL_FINALIST: 'International finalist',
  FINALS_MVP: 'Finals MVP',
  SEASON_MVP: 'Season MVP',
  DOMESTIC_TITLE: 'Domestic title',
};

async function load() {
  if (!managerId.value) return;
  const { data } = await supabase
    .from('collection_cards')
    .select(SELECT)
    .eq('profile_id', managerId.value)
    .eq('card.card_key', route.params.key as string)
    .limit(1);

  const row = (data || []).find((r: any) => r.card);
  if (!row) missing.value = true;
  else held.value = { ...row, card: toCard(row.card) };
  loading.value = false;
}

watch(managerId, load, { immediate: true });

const STATS: Array<[string, string]> = [
  ['laning', 'Lane'], ['teamfight', 'Teamfight'], ['mechanics', 'Mechanics'],
  ['macro', 'Macro'], ['vision', 'Vision'], ['consistency', 'Consistency'],
];
/** Ratings run 40-99; the radar and the bars stretch that range across the full length. */
const share = (v: number) => Math.max(0, Math.min(1, (v - 40) / 59));

/** The hexagon: six axes from the top, clockwise. */
const radar = computed(() => {
  const s = held.value?.card?.subStats || {};
  const pt = (i: number, r: number) => {
    const a = (-90 + i * 60) * (Math.PI / 180);
    return `${(80 + Math.cos(a) * r).toFixed(1)},${(80 + Math.sin(a) * r).toFixed(1)}`;
  };
  return {
    outer: STATS.map((_, i) => pt(i, 64)).join(' '),
    inner: STATS.map((_, i) => pt(i, 32)).join(' '),
    shape: STATS.map(([k], i) => pt(i, 64 * share(Number(s[k] ?? 40)))).join(' '),
    axes: STATS.map((_, i) => pt(i, 64)),
  };
});

const deep = computed(() => (held.value?.card?.championPool || []).filter((p: any) => p.mastery >= 70));
const shallow = computed(() => (held.value?.card?.championPool || []).filter((p: any) => p.mastery < 70));

useHead(() => ({
  title: held.value
    ? `${held.value.card.playerName} ${held.value.card.season} — LOM`
    : 'Card — LOM',
}));
</script>


<template>
  <main class="page page--wide detail">
    <header class="topbar">
      <button class="backlink" type="button" data-sound="back" @click="$router.back()">
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>Back
      </button>
      <span v-if="held" class="rar" :class="`rar--${held.card.rarity.toLowerCase()}`">
        <i class="gem" :class="`gem--${held.card.rarity.toLowerCase()}`" aria-hidden="true" />{{ held.card.rarity.toLowerCase() }}
      </span>
    </header>

    <div v-if="loading" class="skeleton detail-skeleton" />

    <div v-else-if="missing" class="empty">
      <h2>Not in your collection</h2>
      <p>You do not hold this card yet.</p>
      <NuxtLink class="btn" to="/collection">Back to Cards</NuxtLink>
    </div>

    <div v-else-if="held" class="detail__grid">
      <section class="detail__hero">
        <div class="detail__card"><LomCard :card="held.card" /></div>
        <p class="detail__hint">Drag to tilt · tap to turn it over</p>
      </section>

      <section class="detail__info">
        <h1 class="detail__name">{{ held.card.playerName }} <span>{{ held.card.season }}</span></h1>
        <p class="detail__who">{{ held.card.team }} · {{ held.card.region }} · {{ held.card.role }}</p>
        <ul v-if="held.card.accolades?.length" class="accolades">
          <li v-for="a in held.card.accolades" :key="a" class="tag tag--new">{{ ACCOLADES[a] || a }}</li>
        </ul>

        <dl class="facts">
          <div><dt>Overall</dt><dd class="num">{{ held.card.ovr }}</dd></div>
          <div>
            <dt>Level {{ held.level }}</dt>
            <dd class="num">{{ held.xp }}<small>/400 XP</small></dd>
            <div class="meter"><i :style="{ width: `${Math.min(100, (held.xp / 400) * 100)}%` }" /></div>
          </div>
          <div><dt>Copies</dt><dd class="num">{{ held.copies }}</dd></div>
        </dl>

        <section class="block">
          <h2 class="sect">Season {{ held.card.season }}<span class="faint">rated against every {{ held.card.role.toLowerCase() }} that year</span></h2>
          <div class="stats">
            <svg viewBox="0 0 160 160" class="radar" role="img" :aria-label="`Sub-stats: ${STATS.map(([k, l]) => `${l} ${held.card.subStats?.[k]}`).join(', ')}`">
              <polygon :points="radar.outer" fill="none" stroke="rgba(200,215,255,.16)" />
              <polygon :points="radar.inner" fill="none" stroke="rgba(200,215,255,.1)" />
              <line v-for="(a, i) in radar.axes" :key="i" x1="80" y1="80" :x2="a.split(',')[0]" :y2="a.split(',')[1]" stroke="rgba(200,215,255,.07)" />
              <polygon :points="radar.shape" fill="rgba(216,176,100,.16)" stroke="#d8b064" stroke-width="1.5" />
            </svg>
            <ul class="bars">
              <li v-for="[k, label] in STATS" :key="k">
                <span>{{ label }}</span>
                <span class="meter"><i :style="{ width: `${share(held.card.subStats?.[k] ?? 40) * 100}%` }" /></span>
                <b class="tnum">{{ held.card.subStats?.[k] ?? '—' }}</b>
              </li>
            </ul>
          </div>
          <dl v-if="Object.keys(held.card.seasonSummary || {}).length" class="season">
            <div v-for="(value, label) in held.card.seasonSummary" :key="label">
              <dt>{{ label }}</dt>
              <dd class="tnum">{{ value }}</dd>
            </div>
          </dl>
        </section>

        <section class="block">
          <h2 class="sect">Champion pool<span class="faint">mastery · games</span></h2>
          <ul class="pool">
            <li v-for="p in deep" :key="p.key">
              <img :src="`${DDRAGON}/${p.key}.png`" alt="" width="34" height="34" loading="lazy">
              <span class="pool__name">{{ p.champion }}<small>{{ p.games }} games<template v-if="p.winrate"> · {{ Math.round(Number(p.winrate) * 100) }}% wins</template></small></span>
              <span class="meter"><i :style="{ width: `${p.mastery}%` }" /></span>
              <b class="tnum">{{ p.mastery }}</b>
            </li>
          </ul>
          <template v-if="shallow.length">
            <p class="cutline">Below 70 · a penalty in the draft</p>
            <ul class="pool pool--low">
              <li v-for="p in shallow" :key="p.key">
                <img :src="`${DDRAGON}/${p.key}.png`" alt="" width="34" height="34" loading="lazy">
                <span class="pool__name">{{ p.champion }}<small>{{ p.games }} games</small></span>
                <span class="meter"><i :style="{ width: `${p.mastery}%` }" /></span>
                <b class="tnum">{{ p.mastery }}</b>
              </li>
            </ul>
          </template>
        </section>

        <p class="detail__prov">{{ typeof held.card.provenance === 'string' ? held.card.provenance : '' }}</p>
      </section>
    </div>
  </main>
</template>

<style scoped>
.backlink { display: inline-flex; align-items: center; gap: 4px; margin-left: -6px; padding: 0; border: 0; background: none; color: var(--ink-2); font-size: 13.5px; font-weight: 600; cursor: pointer; }
.backlink svg { width: 20px; height: 20px; }
.backlink:hover { color: var(--ink-1); }
.rar { display: inline-flex; align-items: center; gap: 7px; font-stretch: 114%; font-size: 11px; font-weight: 760; letter-spacing: 0.14em; text-transform: uppercase; }
.rar--common { color: var(--r-common); } .rar--rare { color: var(--r-rare); } .rar--epic { color: var(--r-epic); }
.rar--legendary { color: var(--r-legendary); } .rar--icon { color: var(--r-icon); }

.detail-skeleton { aspect-ratio: 63 / 88; max-width: 320px; margin: 0 auto; }
.detail__grid { display: grid; gap: 24px; }
.detail__hero { display: grid; justify-items: center; gap: 10px; }
.detail__card { width: min(100%, 300px); }
.detail__hint { margin: 0; font-size: 12px; color: var(--ink-3); }

.detail__name { font-size: clamp(32px, 8vw, 48px); line-height: 0.92; }
.detail__name span { color: var(--gold-1); }
.detail__who { margin: 6px 0 0; font-size: 13.5px; color: var(--ink-2); }
.accolades { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }

.facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 20px 0 0; border-top: 1px solid var(--line-1); border-bottom: 1px solid var(--line-1); }
.facts > div { padding: 12px 0 12px 14px; border-left: 1px solid var(--line-1); }
.facts > div:first-child { padding-left: 0; border-left: 0; }
.facts dt { font-size: 12px; color: var(--ink-3); }
.facts dd { margin: 4px 0 0; font-size: 26px; }
.facts dd small { font-stretch: 100%; font-weight: 500; font-size: 12px; color: var(--ink-3); margin-left: 2px; }
.facts .meter { margin: 8px 12px 0 0; height: 3px; }

.sect { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin: 0 0 14px; font-stretch: 92%; font-weight: 720; font-size: 17px; }
.sect .faint { font-stretch: 100%; font-weight: 500; font-size: 12.5px; }

.stats { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 18px; align-items: center; }
.radar { width: 150px; height: 150px; }
.bars { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.bars li { display: grid; grid-template-columns: 88px minmax(0, 1fr) 26px; gap: 10px; align-items: center; font-size: 12.5px; color: var(--ink-2); }
.bars .meter { height: 3px; }
.bars .meter i { background: var(--ink-2); }
.bars b { text-align: right; color: var(--ink-1); }

.season { display: grid; grid-template-columns: repeat(auto-fit, minmax(80px, 1fr)); gap: 10px; margin: 18px 0 0; }
.season dt { font-size: 12px; color: var(--ink-3); }
.season dd { margin: 2px 0 0; font-stretch: 80%; font-weight: 800; font-size: 20px; }

.pool { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.pool li { display: grid; grid-template-columns: 34px minmax(0, 1fr) 72px 28px; gap: 12px; align-items: center; padding: 6px 0; }
.pool img { border-radius: 3px; display: block; }
.pool__name { min-width: 0; font-size: 14px; font-weight: 620; }
.pool__name small { display: block; font-size: 11.5px; font-weight: 500; color: var(--ink-3); }
.pool b { text-align: right; font-weight: 760; }
.pool--low { opacity: 0.55; }
.pool--low .meter i { background: var(--ink-3); }
.cutline { display: flex; align-items: center; gap: 10px; margin: 8px 0; font-size: 11.5px; color: var(--ink-3); }
.cutline::after { content: ''; flex: 1; height: 1px; background: var(--line-1); }

.detail__prov { margin: 24px 0 0; font-size: 12px; line-height: 1.6; color: var(--ink-3); }

@media (min-width: 900px) {
  .detail__grid { grid-template-columns: 340px minmax(0, 1fr); gap: 48px; align-items: start; }
  .detail__hero { position: sticky; top: calc(var(--appbar-h) + 20px); }
  .detail__card { width: 100%; }
}
</style>
