<script setup lang="ts">
/**
 * A leaguemate's team and cards.
 *
 * Their five first, then everything they own. That order is the whole point: in a
 * league you want to know what you are up against before you want to browse, and
 * the five they field is the answer to that question. The collection underneath is
 * the bragging.
 *
 * Reached by membership, not by a share code — /m/:code is the version of this
 * screen for somebody you met outside a league. Cards are not links here for the
 * same reason they are not there: the card detail page reads your own collection,
 * so tapping through would land on "you do not have this card".
 */

const route = useRoute();
const leagueId = computed(() => String(route.params.id || ''));
const memberId = computed(() => String(route.params.memberId || ''));

const ROLES = ['TOP', 'JNG', 'MID', 'BOT', 'SUP'];
const BANDS = ['COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'ICON'];

const data = ref<any>(null);
const loading = ref(true);
const error = ref('');
const note = ref('');

const role = ref<string | null>(null);
const band = ref<string | null>(null);
const search = ref('');

const message = (e: any, fallback: string) =>
  e?.statusMessage || e?.data?.statusMessage || e?.data?.message || fallback;

async function load() {
  loading.value = true;
  try {
    data.value = await $fetch<any>(`/api/league/${leagueId.value}/member/${memberId.value}`);
    error.value = '';
  } catch (e: any) {
    error.value = message(e, 'Could not open that team.');
  } finally {
    loading.value = false;
  }
}

watch([leagueId, memberId], load, { immediate: true });

const cards = computed<any[]>(() => data.value?.cards ?? []);
const member = computed<any>(() => data.value?.member ?? null);

const byBand = computed(() => {
  const counts: Record<string, number> = {};
  for (const c of cards.value) counts[c.card.rarity] = (counts[c.card.rarity] || 0) + 1;
  return counts;
});

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

// --- a friendly, from here ---------------------------------------------------

const challenging = ref(false);

async function friendly() {
  if (challenging.value || !member.value) return;
  challenging.value = true;
  note.value = '';
  try {
    await $fetch('/api/duel/challenge', {
      method: 'POST',
      body: { opponentId: member.value.profileId },
    });
    note.value = `Friendly sent to ${member.value.teamName}. It waits until they accept.`;
  } catch (e: any) {
    error.value = message(e, 'Could not send that friendly.');
  } finally {
    challenging.value = false;
  }
}

const BAND_LABEL: Record<string, string> = { COMMON: 'Common', RARE: 'Rare', EPIC: 'Epic', LEGENDARY: 'Legendary', ICON: 'Icon' };
// Rarest first, as on your own Cards screen.
const BANDS_DESC = [...BANDS].reverse();

function clearFilters() {
  role.value = null;
  band.value = null;
  search.value = '';
}

useHead(() => ({
  title: member.value ? `${member.value.teamName} — LOM` : 'Team — LOM',
}));
</script>

<template>
  <main class="page page--wide">
    <header class="topbar">
      <NuxtLink class="backlink" :to="`/leagues/${leagueId}`"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>{{ data?.league?.name || 'League' }}</NuxtLink>
      <span v-if="data" class="topbar__meta tnum">Team {{ data.rosterFilled }}/5</span>
    </header>

    <p v-if="error" class="notice notice--bad" role="alert">{{ error }}</p>
    <p v-if="note" class="notice" role="status">{{ note }}</p>

    <div v-if="loading" class="skeleton head-skeleton" />

    <template v-else-if="data">
      <section class="who">
        <h1 class="who__name">
          {{ member.teamName }}
          <span v-if="member.isMe" class="tag">You</span>
        </h1>
        <p v-if="member.handle" class="muted who__handle">@{{ member.handle }}</p>
        <p class="who__total">
          <span class="num who__n">{{ data.collection.total }}</span>
          <span class="who__unit">{{ data.collection.total === 1 ? 'card' : 'cards' }}</span>
        </p>
        <p v-if="data.collection.best" class="muted who__best">
          Best: {{ data.collection.best.playerName }}
          <template v-if="data.collection.best.season">{{ data.collection.best.season }}</template>
          · <span class="tnum">{{ data.collection.best.ovr }}</span> OVR
        </p>

        <button
          v-if="!member.isMe" class="btn who__act" type="button"
          :disabled="challenging || data.rosterFilled < 5" @click="friendly"
        >
          {{ challenging ? 'Sending' : data.rosterFilled < 5 ? 'No full team yet' : 'Friendly' }}
        </button>
        <p v-if="!member.isMe" class="faint who__hint">
          A friendly does not count in the table.
        </p>
      </section>

      <!-- The team. What you are actually up against. -->
      <section class="block">
        <h2 class="sect">Team</h2>
        <ul class="five">
          <li v-for="r in ROLES" :key="r" class="five__slot">
            <span class="five__role">{{ r }}</span>
            <LomCard v-if="data.roster[r]" :card="data.roster[r].card" compact />
            <div v-else class="five__empty">Empty</div>
          </li>
        </ul>
      </section>

      <section class="block">
        <h2 class="sect">Cards</h2>

        <div class="cards__layout">
          <aside v-if="cards.length" class="filters">
            <input
              v-model="search" class="input filters__search" type="search"
              placeholder="Player, team or champion" aria-label="Search these cards"
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
                v-for="b in BANDS_DESC" :key="b" class="chip" type="button"
                :aria-pressed="band === b" :disabled="!byBand[b]"
                @click="band = band === b ? null : b"
              >
                <i class="gem" :class="`gem--${b.toLowerCase()}`" aria-hidden="true" />
                {{ BAND_LABEL[b] }}<span class="chip__n">{{ byBand[b] || 0 }}</span>
              </button>
            </div>
          </aside>

          <div class="cards__main">
            <p v-if="cards.length" class="cards__count faint">
              {{ filtered.length }} shown · highest rating first
            </p>

            <div v-if="!cards.length" class="empty">
              <h2>Nothing here yet</h2>
              <p>{{ member.teamName }} has not opened a pack.</p>
            </div>

            <div v-else-if="!filtered.length" class="empty">
              <h2>No match</h2>
              <p>None of these cards fit those filters.</p>
              <button class="btn btn--ghost" type="button" @click="clearFilters">Clear filters</button>
            </div>

            <div v-else class="card-grid">
              <div v-for="item in filtered" :key="item.id" class="card-grid__item">
                <LomCard :card="item.card" compact />
                <span v-if="item.level > 1" class="card-grid__badge">Lv {{ item.level }}</span>
                <span v-if="item.copies > 1" class="card-grid__dupes">×{{ item.copies }}</span>
              </div>
            </div>
          </div>
        </div>
      </section>
    </template>
  </main>
</template>

<style scoped>
.backlink { display: inline-flex; align-items: center; gap: 4px; min-height: 44px; min-width: 0; margin-left: -6px; padding-right: 8px; font-size: 13.5px; font-weight: 600; color: var(--ink-2); }
.backlink svg { width: 20px; height: 20px; flex: none; }
.backlink:hover { color: var(--ink-1); }

.head-skeleton { height: 28vh; }

.who__name { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-size: clamp(30px, 7vw, 44px); line-height: 0.95; margin: 4px 0 0; }
.who__handle { font-size: 13.5px; margin: 6px 0 0; }
.who__total { display: flex; align-items: baseline; gap: 7px; margin: 14px 0 0; }
.who__n { font-size: 30px; }
.who__unit { font-size: 13px; font-weight: 600; color: var(--ink-3); }
.who__best { font-size: 13.5px; margin: 6px 0 0; }
.who__act { margin-top: 16px; }
.who__hint { font-size: 12px; margin: 8px 0 0; }

.block { margin-top: 28px; }
.sect { margin: 0 0 12px; font-stretch: 92%; font-weight: 720; font-size: 17px; }

/* Five across on a phone: the roles are the point, so they stay in one row and the
   cards get narrow rather than wrapping into a shape nobody can read as a team. */
.five { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
.five__slot { display: grid; gap: 6px; align-content: start; min-width: 0; }
.five__role {
  font-stretch: 114%;
  font-size: 10.5px;
  font-weight: 760;
  letter-spacing: 0.12em;
  text-align: center;
  color: var(--ink-3);
}
.five__empty {
  display: grid;
  place-items: center;
  aspect-ratio: 63 / 88;
  border: 1px dashed var(--line-2);
  border-radius: var(--radius);
  color: var(--ink-4);
  font-size: 12px;
  font-weight: 600;
}
@media (min-width: 720px) {
  .five { gap: 12px; }
}

.filters { display: grid; gap: 10px; margin-bottom: 16px; }
.filters__search { min-height: 44px; font-size: 16px; }
.filters__roles button { font-size: 11px; }
.filters__bands { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; margin-right: -16px; padding-right: 16px; }
.filters__bands::-webkit-scrollbar { display: none; }
.cards__count { margin: 0 0 12px; font-size: 12.5px; }

@media (min-width: 1024px) {
  .cards__layout { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 36px; align-items: start; }
  .cards__layout:not(:has(.filters)) { grid-template-columns: minmax(0, 1fr); }
  .filters { position: sticky; top: calc(var(--appbar-h) + 16px); }
  .filters__roles { flex-direction: column; }
  .filters__roles button { justify-content: flex-start; padding: 0 12px; }
  .filters__bands { flex-direction: column; margin: 0; padding: 0; overflow: visible; }
  .filters__bands .chip { justify-content: flex-start; }
  .filters__bands .chip__n { margin-left: auto; }
}
</style>
