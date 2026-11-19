<script setup lang="ts">
import { ROLES, chemistryFor, coverageFor, averageRating, DEPTH_MASTERY } from '~~/shared/roster';

/**
 * The roster: five slots, one per role, filled from cards you own.
 *
 * Text rows rather than card art. docs/09 section 6 draws it this way and it is
 * right: this screen is a comparison — who is in, what they bring, where the holes
 * are — and five pieces of card art answer none of those questions while pushing the
 * chemistry and coverage readouts off the first screen.
 *
 * Every change saves on the tap. The slot updates locally first and rolls back if
 * the endpoint refuses, so picking a card feels like picking a card and not like
 * filing a form.
 */

const data = ref<any>(null);
const loading = ref(true);
const error = ref('');

const picking = ref<string | null>(null);
const search = ref('');
const saving = ref(false);

const message = (e: any, fallback: string) =>
  e?.statusMessage || e?.data?.statusMessage || e?.data?.message || fallback;

async function load() {
  try {
    data.value = await $fetch<any>('/api/roster');
    error.value = '';
  } catch (e: any) {
    error.value = message(e, 'Could not load your roster.');
  } finally {
    loading.value = false;
  }
}

onMounted(load);

/** The five slots as the rules module wants them: role -> card, nulls included. */
const slots = computed<Record<string, any>>(() => {
  const out: Record<string, any> = {};
  for (const role of ROLES) out[role] = data.value?.roster?.[role]?.card ?? null;
  return out;
});

const held = (role: string) => data.value?.roster?.[role] ?? null;

const chemistry = computed(() => chemistryFor(slots.value));
const coverage = computed(() => coverageFor(slots.value));
const rating = computed(() => averageRating(slots.value));
const filledCount = computed(() => ROLES.filter((r) => slots.value[r]).length);

const owned = computed<any[]>(() => data.value?.owned ?? []);

/** What can go in the slot being picked for: right role, sorted by the obvious pick. */
const candidates = computed(() => {
  const role = picking.value;
  if (!role) return [];
  const q = search.value.trim().toLowerCase();

  return owned.value
    .filter((c) => c.card.role === role)
    .filter((c) => {
      if (!q) return true;
      const hay = `${c.card.playerName} ${c.card.team} ${c.card.season} `
        + c.card.championPool.map((p: any) => p.champion).join(' ');
      return hay.toLowerCase().includes(q);
    })
    .sort((a, b) => b.card.ovr - a.card.ovr);
});

const depth = (card: any) =>
  (card.championPool || []).filter((p: any) => p.mastery >= DEPTH_MASTERY).length;

function openPicker(role: string) {
  picking.value = role;
  search.value = '';
}

async function choose(role: string, entry: any | null) {
  if (saving.value) return;

  const before = data.value.roster[role];
  // Optimistic, and it has to clear the card's old slot too, or it shows up twice
  // until the reload lands.
  if (entry) {
    for (const other of ROLES) {
      if (other !== role && data.value.roster[other]?.id === entry.id) {
        data.value.roster[other] = null;
      }
    }
  }
  data.value.roster[role] = entry;
  picking.value = null;

  saving.value = true;
  try {
    await $fetch('/api/roster/slot', {
      method: 'POST',
      body: { role, collectionCardId: entry?.id ?? null },
    });
    error.value = '';
  } catch (e: any) {
    data.value.roster[role] = before;
    error.value = message(e, 'That change did not save.');
    await load();
  } finally {
    saving.value = false;
  }
}

useHead({ title: 'Roster — LOM' });
</script>

<template>
  <main class="page">
    <header class="topbar">
      <h1>Roster</h1>
      <span class="topbar__meta">{{ filledCount }} / 5</span>
    </header>

    <p v-if="error" class="notice notice--bad">{{ error }}</p>

    <div v-if="loading" class="skeleton sheet-skeleton" />

    <template v-else-if="data">
      <section class="panel totals">
        <div class="totals__cell">
          <p class="eyebrow">Rating</p>
          <p class="totals__n tnum">{{ rating || '—' }}</p>
        </div>
        <div class="totals__cell">
          <p class="eyebrow">Chemistry</p>
          <p class="totals__n tnum" :class="{ 'is-on': chemistry.average > 0 }">
            {{ chemistry.average ? `+${chemistry.average}` : '—' }}
          </p>
        </div>
        <div class="totals__cell">
          <p class="eyebrow">Pool</p>
          <p class="totals__n tnum">{{ coverage.champions || '—' }}</p>
        </div>
      </section>

      <ul class="slots">
        <li v-for="role in ROLES" :key="role">
          <button class="slot" type="button" @click="openPicker(role)">
            <span class="slot__role">{{ role }}</span>

            <span v-if="slots[role]" class="slot__card">
              <span class="slot__name">
                {{ slots[role].playerName }}
                <span v-if="slots[role].season" class="slot__season">{{ slots[role].season }}</span>
              </span>
              <span class="muted slot__meta">
                {{ slots[role].team || 'Unknown team' }}
                · {{ depth(slots[role]) }} deep
                <template v-if="held(role)?.level > 1"> · LV {{ held(role).level }}</template>
              </span>
              <span v-if="chemistry.byRole[role].bonus" class="slot__chem">
                +{{ chemistry.byRole[role].bonus }} · {{ chemistry.byRole[role].reasons.join(' · ') }}
              </span>
            </span>

            <span v-else class="slot__empty">Pick a {{ role }}</span>

            <span class="slot__ovr tnum" :class="slots[role] ? `is-${slots[role].rarity.toLowerCase()}` : ''">
              {{ slots[role] ? slots[role].ovr : '··' }}
            </span>
          </button>
        </li>
      </ul>

      <section class="panel read">
        <p class="eyebrow">What this roster covers</p>
        <p class="read__line">
          <template v-if="coverage.champions">
            {{ coverage.champions }} champions at mastery {{ DEPTH_MASTERY }} or better.
            <template v-if="coverage.weakest">
              Thinnest: {{ coverage.weakest.role }} with {{ coverage.weakest.champions }}.
            </template>
          </template>
          <template v-else>
            Fill a slot and the combined champion pool shows up here.
          </template>
        </p>

        <template v-if="chemistry.cores.length || chemistry.teamWide.length">
          <p class="eyebrow read__eyebrow">Chemistry</p>
          <ul class="read__chem">
            <li v-for="core in chemistry.cores" :key="core.label">
              <strong>{{ core.label }}</strong> ×{{ core.size }} — +{{ core.bonus }} each
            </li>
            <li v-for="line in chemistry.teamWide" :key="line">
              <strong>{{ line }}</strong> — +1 each
            </li>
          </ul>
        </template>
        <p v-else-if="filledCount > 1" class="muted read__line">
          No chemistry yet. Two cards from the same real team and season are worth +1.5 each,
          three or more +2.5, and a full five sharing a region or a year +1 on top.
        </p>
      </section>

      <p class="faint foot">
        A roster is yours to keep — it changes nothing yet. Fixtures, strategy and the draft
        are what it feeds once matches land.
      </p>
    </template>

    <!-- Picker -->
    <div v-if="picking" class="picker" role="dialog" aria-modal="true" :aria-label="`Pick a ${picking}`">
      <div class="picker__scrim" @click="picking = null" />
      <div class="picker__sheet">
        <header class="picker__head">
          <h2>{{ picking }}</h2>
          <button class="btn btn--quiet" type="button" @click="picking = null">Close</button>
        </header>

        <input
          v-model="search" class="picker__search" type="search"
          placeholder="Player, team or champion" :aria-label="`Search your ${picking} cards`"
        >

        <button
          v-if="slots[picking]" class="picker__clear" type="button"
          @click="choose(picking, null)"
        >
          Empty this slot
        </button>

        <ul v-if="candidates.length" class="picker__list">
          <li v-for="entry in candidates" :key="entry.id">
            <button
              class="pick" type="button"
              :aria-current="held(picking)?.id === entry.id"
              @click="choose(picking!, entry)"
            >
              <span class="pick__main">
                <span class="pick__name">
                  {{ entry.card.playerName }}
                  <span v-if="entry.card.season" class="slot__season">{{ entry.card.season }}</span>
                </span>
                <span class="muted pick__meta">
                  {{ entry.card.team || 'Unknown team' }} · {{ depth(entry.card) }} deep
                  <template v-if="entry.level > 1"> · LV {{ entry.level }}</template>
                </span>
              </span>
              <span class="pick__ovr tnum" :class="`is-${entry.card.rarity.toLowerCase()}`">
                {{ entry.card.ovr }}
              </span>
            </button>
          </li>
        </ul>

        <div v-else class="empty picker__empty">
          <h2>No {{ picking }} cards</h2>
          <p>Nothing in your collection plays there yet.</p>
          <NuxtLink class="btn" to="/pack" @click="picking = null">Go to the pack</NuxtLink>
        </div>
      </div>
    </div>
  </main>
</template>

<style scoped>
.sheet-skeleton { height: 320px; border-radius: var(--radius); }

.totals { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.totals__cell { text-align: center; }
.totals__n { font-family: var(--font-display); font-size: 27px; font-weight: 700; margin: 4px 0 0; }
.totals__n.is-on { color: var(--accent); }

.slots { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 8px; }
.slot {
  width: 100%;
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-height: 70px;
  padding: 12px 14px;
  text-align: left;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  color: var(--ink);
  font: inherit;
  cursor: pointer;
}
.slot:hover { border-color: var(--line-strong); }
.slot__role {
  font-family: var(--font-label);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.14em;
  color: var(--ink-faint);
}
.slot__card { display: grid; gap: 2px; min-width: 0; }
.slot__name { font-family: var(--font-display); font-size: 17px; font-weight: 700; }
.slot__season { color: var(--ink-dim); font-weight: 600; }
.slot__meta, .pick__meta { font-size: 12.5px; }
.slot__chem {
  font-family: var(--font-label);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--accent);
  margin-top: 2px;
}
.slot__empty { color: var(--ink-faint); font-size: 15px; }
.slot__ovr, .pick__ovr { font-family: var(--font-display); font-size: 22px; font-weight: 700; }

.is-common { color: var(--r-common); }
.is-rare { color: var(--r-rare); }
.is-epic { color: var(--r-epic); }
.is-legendary { color: var(--r-legendary); }
.is-icon { color: var(--r-icon); }

.read { margin-top: 12px; }
.read__line { font-size: 13.5px; line-height: 1.6; margin: 8px 0 0; }
.read__eyebrow { margin-top: 14px; }
.read__chem { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 5px; font-size: 13.5px; }
.read__chem strong { font-weight: 700; }

.foot { font-size: 12.5px; line-height: 1.5; margin: 16px 0 0; text-align: center; }

.picker { position: fixed; inset: 0; z-index: 40; display: flex; align-items: flex-end; }
.picker__scrim { position: absolute; inset: 0; background: rgba(4, 6, 12, 0.72); }
.picker__sheet {
  position: relative;
  width: 100%;
  max-height: 86vh;
  overflow-y: auto;
  padding: 16px 16px calc(20px + env(safe-area-inset-bottom, 0px));
  background: var(--surface);
  border-top: 1px solid var(--line-strong);
  border-radius: 14px 14px 0 0;
}
@media (min-width: 640px) {
  .picker { align-items: center; justify-content: center; }
  .picker__sheet { max-width: 520px; border-radius: 14px; border: 1px solid var(--line-strong); }
}
.picker__head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.picker__head h2 {
  font-family: var(--font-label);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  margin: 0;
}
.picker__search {
  width: 100%;
  min-height: 44px;
  margin-top: 12px;
  padding: 0 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--sunken);
  color: var(--ink);
  font-family: inherit;
  font-size: 16px;
}
.picker__search:focus { border-color: var(--accent); outline: none; }
.picker__clear {
  width: 100%;
  margin-top: 10px;
  padding: 10px;
  background: transparent;
  border: 1px dashed var(--line-strong);
  border-radius: 8px;
  color: var(--ink-dim);
  font: inherit;
  font-size: 13.5px;
  cursor: pointer;
}
.picker__clear:hover { color: var(--bad); border-color: var(--bad); }

.picker__list { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 6px; }
.pick {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 60px;
  padding: 10px 12px;
  text-align: left;
  background: var(--sunken);
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--ink);
  font: inherit;
  cursor: pointer;
}
.pick:hover { border-color: var(--line-strong); }
.pick[aria-current='true'] { border-color: var(--accent); }
.pick__main { display: grid; gap: 2px; min-width: 0; }
.pick__name { font-family: var(--font-display); font-size: 16px; font-weight: 700; }
.picker__empty { margin-top: 16px; }
</style>
