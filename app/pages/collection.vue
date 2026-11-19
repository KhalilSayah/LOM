<script setup lang="ts">
import { toCard } from '~~/shared/cardShape';

const supabase = useSupabaseClient();
const user = useSupabaseUser();
const managerId = useManagerId();

const ROLES = ['TOP', 'JNG', 'MID', 'BOT', 'SUP'];
const BANDS = ['COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'ICON'];

const rows = ref<any[]>([]);
const loading = ref(true);
const error = ref('');

const role = ref<string | null>(null);
const band = ref<string | null>(null);
const search = ref('');

const SELECT = `
  id, level, xp, copies, acquired_at,
  card:card_definitions (
    card_key, player_name, season, team, region, role, ovr, rarity,
    sub_stats, accolades, season_summary, provenance, art_champion_key, art_focus,
    pool:card_champion_pool ( champion_key, champion_name, games, winrate, mastery, slot )
  )
`;

// Which cards are in the roster, so a tile can say so. Read straight from Postgres
// like the collection itself — roster_slots is one of the tables RLS lets a manager
// read their own rows of, and the roster endpoint exists for the writes.
const inRoster = ref<Record<string, string>>({});

async function load() {
  if (!managerId.value) return;
  loading.value = true;
  const [{ data, error: err }, { data: slots }] = await Promise.all([
    supabase
      .from('collection_cards')
      .select(SELECT)
      .eq('profile_id', managerId.value)
      .order('acquired_at', { ascending: false }),
    supabase
      .from('roster_slots')
      .select('role, collection_card_id')
      .eq('profile_id', managerId.value),
  ]);

  if (err) error.value = err.message;
  else rows.value = (data || []).filter((r: any) => r.card);

  const held: Record<string, string> = {};
  for (const slot of (slots || []) as any[]) held[slot.collection_card_id] = slot.role;
  inRoster.value = held;

  loading.value = false;
}

watch(managerId, load, { immediate: true });

const cards = computed(() => rows.value.map((r: any) => ({
  id: r.id,
  level: r.level,
  copies: r.copies,
  card: toCard(r.card),
})));

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return cards.value
    .filter((c) => !role.value || c.card.role === role.value)
    .filter((c) => !band.value || c.card.rarity === band.value)
    .filter((c) => {
      if (!q) return true;
      const hay = `${c.card.playerName} ${c.card.team} ${c.card.season} `
        + c.card.championPool.map((p: any) => p.champion).join(' ');
      return hay.toLowerCase().includes(q);
    })
    .sort((a, b) => b.card.ovr - a.card.ovr);
});

const byBand = computed(() => {
  const counts: Record<string, number> = {};
  for (const c of cards.value) counts[c.card.rarity] = (counts[c.card.rarity] || 0) + 1;
  return counts;
});

useHead({ title: 'Collection — LOM' });
</script>

<template>
  <main class="page page--wide">
    <header class="topbar">
      <h1>Collection</h1>
      <span class="topbar__meta">{{ cards.length }} {{ cards.length === 1 ? 'card' : 'cards' }}</span>
    </header>

    <p v-if="error" class="notice notice--bad">{{ error }}</p>

    <div v-if="cards.length" class="filters">
      <input
        v-model="search" class="filters__search" type="search"
        placeholder="Player, team or champion" aria-label="Search your collection"
      >
      <div class="chips">
        <button class="chip" :aria-pressed="role === null" @click="role = null">All</button>
        <button
          v-for="r in ROLES" :key="r" class="chip"
          :aria-pressed="role === r" @click="role = role === r ? null : r"
        >{{ r }}</button>
      </div>
      <div class="chips">
        <button
          v-for="b in BANDS" :key="b" class="chip"
          :aria-pressed="band === b" :disabled="!byBand[b]"
          @click="band = band === b ? null : b"
        >
          {{ b.toLowerCase() }}<span v-if="byBand[b]" class="chip__n"> {{ byBand[b] }}</span>
        </button>
      </div>
    </div>

    <div v-if="loading" class="card-grid">
      <div v-for="i in 6" :key="i" class="skeleton grid-skeleton" />
    </div>

    <div v-else-if="!cards.length" class="empty">
      <h2>Nothing yet</h2>
      <p>Open today's pack and your first card lands here.</p>
      <NuxtLink class="btn" to="/pack">Go to the pack</NuxtLink>
    </div>

    <div v-else-if="!filtered.length" class="empty">
      <h2>No match</h2>
      <p>Nothing in your collection fits those filters.</p>
    </div>

    <div v-else class="card-grid">
      <NuxtLink
        v-for="item in filtered" :key="item.id"
        class="card-grid__item" :to="`/card/${item.card.cardKey}`"
      >
        <span v-if="item.level > 1" class="card-grid__badge">LV {{ item.level }}</span>
        <span v-if="inRoster[item.id]" class="card-grid__slot">{{ inRoster[item.id] }}</span>
        <span v-if="item.copies > 1" class="card-grid__dupes">×{{ item.copies }}</span>
        <LomCard :card="item.card" compact :interactive="false" />
      </NuxtLink>
    </div>
  </main>
</template>

<style scoped>
.filters { display: grid; gap: 8px; margin-bottom: 16px; }
.filters__search {
  width: 100%;
  min-height: 44px;
  padding: 0 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--sunken);
  color: var(--ink);
  font-family: inherit;
  font-size: 16px;
}
.filters__search:focus { border-color: var(--accent); outline: none; }
.chip:disabled { opacity: 0.35; cursor: default; }
.chip__n { opacity: 0.7; margin-left: 2px; }
.grid-skeleton { aspect-ratio: 63 / 88; }
</style>
