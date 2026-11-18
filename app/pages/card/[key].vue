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

useHead(() => ({
  title: held.value
    ? `${held.value.card.playerName} ${held.value.card.season} — LOM`
    : 'Card — LOM',
}));
</script>

<template>
  <main class="page">
    <header class="topbar">
      <button class="btn btn--quiet" type="button" @click="$router.back()">Back</button>
      <span v-if="held" class="topbar__meta">{{ held.card.rarity.toLowerCase() }}</span>
    </header>

    <div v-if="loading" class="skeleton detail-skeleton" />

    <div v-else-if="missing" class="empty">
      <h2>Not in your collection</h2>
      <p>You do not hold this card yet.</p>
      <NuxtLink class="btn" to="/collection">Back to collection</NuxtLink>
    </div>

    <template v-else-if="held">
      <div class="detail__card">
        <LomCard :card="held.card" />
      </div>
      <p class="detail__hint faint">Drag to tilt. Tap to turn it over.</p>

      <section class="panel detail__block">
        <p class="eyebrow">Season</p>
        <dl class="detail__stats">
          <div v-for="(value, label) in held.card.seasonSummary" :key="label">
            <dt>{{ label }}</dt>
            <dd class="tnum">{{ value }}</dd>
          </div>
        </dl>
      </section>

      <section class="panel detail__block">
        <p class="eyebrow">Champion pool</p>
        <ul class="pool">
          <li v-for="p in held.card.championPool" :key="p.key">
            <img :src="`${DDRAGON}/${p.key}.png`" alt="" width="32" height="32" loading="lazy">
            <span class="pool__name">{{ p.champion }}</span>
            <span class="pool__bar"><span :style="{ width: `${p.mastery}%` }" /></span>
            <span class="pool__m tnum">{{ p.mastery }}</span>
            <span class="pool__g tnum faint">{{ p.games }}g</span>
          </li>
        </ul>
      </section>

      <section v-if="held.card.accolades?.length" class="panel detail__block">
        <p class="eyebrow">Accolades</p>
        <ul class="accolades">
          <li v-for="a in held.card.accolades" :key="a">{{ ACCOLADES[a] || a }}</li>
        </ul>
      </section>

      <section class="panel detail__block">
        <p class="eyebrow">Your copy</p>
        <dl class="detail__stats">
          <div><dt>Level</dt><dd class="tnum">{{ held.level }}</dd></div>
          <div><dt>XP</dt><dd class="tnum">{{ held.xp }}/400</dd></div>
          <div><dt>Copies</dt><dd class="tnum">{{ held.copies }}</dd></div>
        </dl>
      </section>

      <p class="detail__prov faint">{{ held.card.provenance }}</p>
    </template>
  </main>
</template>

<style scoped>
.detail-skeleton { aspect-ratio: 63 / 88; max-width: 320px; margin: 0 auto; }
.detail__card { max-width: 320px; margin: 0 auto; width: 100%; }
.detail__hint { text-align: center; font-size: 12.5px; margin: 10px 0 18px; }
.detail__block { margin-bottom: 12px; }
.detail__stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(72px, 1fr));
  gap: 10px;
  margin: 8px 0 0;
}
.detail__stats dt {
  font-family: var(--font-label);
  font-size: 12px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ink-faint);
}
.detail__stats dd { margin: 2px 0 0; font-family: var(--font-display); font-size: 19px; font-weight: 700; }

.pool { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 8px; }
.pool li {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) 70px 28px 34px;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}
.pool img { border-radius: 5px; display: block; }
.pool__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pool__bar { height: 5px; border-radius: 3px; background: var(--surface-2); overflow: hidden; }
.pool__bar span { display: block; height: 100%; background: var(--accent); }
.pool__m { font-weight: 700; color: var(--accent); text-align: right; }
.pool__g { text-align: right; font-size: 12.5px; }

.accolades { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.accolades li {
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--surface-2);
  font-family: var(--font-label);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--accent);
}

.detail__prov { font-size: 12px; line-height: 1.6; margin: 14px 0 0; }
</style>
