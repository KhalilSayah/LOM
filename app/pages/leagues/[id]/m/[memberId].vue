<script setup lang="ts">
/**
 * A leaguemate's squad.
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
    data.value = await $fetch<any>(`/api/leagues/${leagueId.value}/member/${memberId.value}`);
    error.value = '';
  } catch (e: any) {
    error.value = message(e, 'Could not open that squad.');
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

useHead(() => ({
  title: member.value ? `${member.value.teamName} — LOM` : 'Squad — LOM',
}));
</script>

<template>
  <main class="page page--wide">
    <header class="topbar">
      <NuxtLink class="btn btn--quiet" :to="`/leagues/${leagueId}`">
        {{ data?.league?.name || 'League' }}
      </NuxtLink>
      <span v-if="data" class="topbar__meta">{{ data.rosterFilled }}/5 roster</span>
    </header>

    <p v-if="error" class="notice notice--bad">{{ error }}</p>
    <p v-if="note" class="notice">{{ note }}</p>

    <div v-if="loading" class="skeleton head-skeleton" />

    <template v-else-if="data">
      <section class="panel who">
        <p class="eyebrow">{{ member.isMe ? 'You' : 'Manager' }}</p>
        <p class="who__name">{{ member.teamName }}</p>
        <p v-if="member.handle" class="muted who__handle">@{{ member.handle }}</p>
        <p class="who__total">
          <span class="tnum who__n">{{ data.collection.total }}</span>
          <span class="who__unit">{{ data.collection.total === 1 ? 'card' : 'cards' }}</span>
        </p>
        <p v-if="data.collection.best" class="muted who__best">
          Best: {{ data.collection.best.playerName }}
          <template v-if="data.collection.best.season">{{ data.collection.best.season }}</template>
          · {{ data.collection.best.ovr }} OVR
        </p>

        <button
          v-if="!member.isMe" class="btn who__act" type="button"
          :disabled="challenging || data.rosterFilled < 5" @click="friendly"
        >
          {{ challenging ? 'Sending' : data.rosterFilled < 5 ? 'No full roster yet' : 'Friendly' }}
        </button>
      </section>

      <!-- The five. What you are actually up against. -->
      <section class="block">
        <p class="eyebrow">The five</p>
        <div class="five">
          <div v-for="r in ROLES" :key="r" class="five__slot">
            <span class="five__role">{{ r }}</span>
            <LomCard v-if="data.roster[r]" :card="data.roster[r].card" compact />
            <div v-else class="five__empty">Empty</div>
          </div>
        </div>
      </section>

      <section class="block">
        <p class="eyebrow">Collection</p>

        <div v-if="cards.length" class="filters">
          <input
            v-model="search" class="filters__search" type="search"
            placeholder="Player, team or champion" aria-label="Search this collection"
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

        <div v-if="!cards.length" class="empty">
          <h2>Nothing here yet</h2>
          <p>{{ member.teamName }} has not opened a pack.</p>
        </div>

        <div v-else-if="!filtered.length" class="empty">
          <h2>No match</h2>
          <p>Nothing in this collection fits those filters.</p>
        </div>

        <div v-else class="card-grid">
          <div v-for="item in filtered" :key="item.id" class="card-grid__item">
            <span v-if="item.level > 1" class="card-grid__badge">LV {{ item.level }}</span>
            <span v-if="item.copies > 1" class="card-grid__dupes">×{{ item.copies }}</span>
            <LomCard :card="item.card" compact />
          </div>
        </div>
      </section>
    </template>
  </main>
</template>

<style scoped>
.head-skeleton { height: 28vh; }

.who__name { font-family: var(--font-display); font-size: 24px; font-weight: 700; margin: 6px 0 0; }
.who__handle { font-size: 13.5px; margin: 2px 0 0; }
.who__total { display: flex; align-items: baseline; gap: 7px; margin: 12px 0 0; }
.who__n { font-family: var(--font-display); font-size: 30px; font-weight: 700; }
.who__unit {
  font-family: var(--font-label);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--ink-dim);
}
.who__best { font-size: 13.5px; margin: 8px 0 0; }
.who__act { margin-top: 12px; }

.block { margin-top: 18px; }

/* Five across on a phone: the roles are the point, so they stay in one row and the
   cards get narrow rather than wrapping into a shape nobody can read as a lineup. */
.five { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; margin-top: 8px; }
.five__slot { display: grid; gap: 4px; }
.five__role {
  font-family: var(--font-label);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-align: center;
  color: var(--ink-faint);
}
.five__empty {
  display: grid;
  place-items: center;
  aspect-ratio: 63 / 88;
  border: 1px dashed var(--line-strong);
  border-radius: 8px;
  color: var(--ink-faint);
  font-family: var(--font-label);
  font-size: 11px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.filters { display: grid; gap: 8px; margin: 10px 0 14px; }
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
</style>
