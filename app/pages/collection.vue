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
  isNew: Date.now() - new Date(r.acquired_at).getTime() < 36 * 3600 * 1000,
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

const BAND_LABEL: Record<string, string> = { COMMON: 'Common', RARE: 'Rare', EPIC: 'Epic', LEGENDARY: 'Legendary', ICON: 'Icon' };

useHead({ title: 'Cards — LOM' });
</script>


<template>
  <main class="page page--full cards">
    <header class="topbar">
      <h1>Cards</h1>
      <span class="topbar__meta tnum">{{ cards.length }} {{ cards.length === 1 ? 'card' : 'cards' }}</span>
    </header>

    <p v-if="error" class="notice notice--bad">{{ error }}</p>

    <div class="cards__layout">
      <aside v-if="cards.length" class="filters">
        <input
          v-model="search" class="input filters__search" type="search"
          placeholder="Player, team or champion" aria-label="Search your cards"
        >
        <div class="seg filters__roles" role="group" aria-label="Role">
          <button type="button" :aria-pressed="role === null" @click="role = null">All</button>
          <button
            v-for="r in ROLES" :key="r" type="button"
            :aria-pressed="role === r" @click="role = role === r ? null : r"
          >{{ r }}</button>
        </div>
        <div class="filters__bands" role="group" aria-label="Rarity">
          <button
            v-for="b in [...BANDS].reverse()" :key="b" class="chip" type="button"
            :aria-pressed="band === b" :disabled="!byBand[b]"
            @click="band = band === b ? null : b"
          >
            <i class="gem" :class="`gem--${b.toLowerCase()}`" aria-hidden="true" />
            {{ BAND_LABEL[b] }}<span class="chip__n">{{ byBand[b] || 0 }}</span>
          </button>
        </div>
      </aside>

      <section class="cards__main">
        <p v-if="cards.length" class="cards__count faint">
          {{ filtered.length }} shown · highest rating first
        </p>

        <div v-if="loading" class="card-grid">
          <div v-for="i in 9" :key="i" class="skeleton grid-skeleton" />
        </div>

        <div v-else-if="!cards.length" class="empty">
          <h2>Nothing yet</h2>
          <p>Open today's pack and your first card lands here.</p>
          <NuxtLink class="btn" to="/pack">Go to the pack</NuxtLink>
        </div>

        <div v-else-if="!filtered.length" class="empty">
          <h2>No match</h2>
          <p>Nothing in your collection fits those filters.</p>
          <button class="btn btn--ghost" type="button" @click="role = null; band = null; search = ''">Clear filters</button>
        </div>

        <div v-else class="card-grid">
          <NuxtLink
            v-for="item in filtered" :key="item.id"
            class="card-grid__item" :to="`/card/${item.card.cardKey}`"
          >
            <LomCard :card="item.card" compact :interactive="false" />
            <span v-if="item.isNew" class="card-grid__badge card-grid__badge--new">New</span>
            <span v-else-if="item.level > 1" class="card-grid__badge">Lv {{ item.level }}</span>
            <span v-if="inRoster[item.id]" class="card-grid__slot">{{ inRoster[item.id] }}</span>
            <span v-if="item.copies > 1" class="card-grid__dupes">×{{ item.copies }}</span>
          </NuxtLink>
        </div>
      </section>
    </div>
  </main>
</template>

<style scoped>
.filters { display: grid; gap: 10px; margin-bottom: 16px; }
.filters__search { min-height: 44px; font-size: 15px; }
.filters__roles button { font-size: 11px; }
.filters__bands { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; margin-right: -16px; padding-right: 16px; }
.filters__bands::-webkit-scrollbar { display: none; }
.cards__count { margin: 0 0 12px; font-size: 12.5px; }
.grid-skeleton { aspect-ratio: 63 / 88; }
.card-grid__badge--new { --tag: var(--gold-2); color: var(--gold-ink) !important; }

@media (min-width: 1024px) {
  .cards__layout { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 36px; align-items: start; }
  .filters { position: sticky; top: calc(var(--appbar-h) + 16px); }
  .filters__roles { flex-direction: column; }
  .filters__roles button { justify-content: flex-start; padding: 0 12px; }
  .filters__bands { flex-direction: column; margin: 0; padding: 0; overflow: visible; }
  .filters__bands .chip { justify-content: flex-start; }
  .filters__bands .chip__n { margin-left: auto; }
}
</style>
