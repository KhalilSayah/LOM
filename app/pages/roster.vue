<script setup lang="ts">
import { ROLES, chemistryFor, coverageFor, averageRating, DEPTH_MASTERY } from '~~/shared/roster';

/**
 * The roster: five slots, one per role, filled from cards you own.
 *
 * This was a list of text rows, which is how docs/09 section 6 sketches it. The sketch is
 * wrong for this game. A lineup in a collecting game is the thing you show people, and five
 * rows of "Zeus 2023 · 86" show nothing — the art, the frame and the rarity are most of why
 * a card is worth owning, and none of them survive being flattened into a row.
 *
 * So it is a board: five slots you can see at once, your cards underneath, tap one to put it
 * in. Tapping a slot selects it rather than opening a modal, because a modal hides the board
 * you are trying to build and makes comparing two options a round trip.
 *
 * The readouts that justified the rows — chemistry, pool coverage — stay. They sit above the
 * board where they still answer "is this lineup any good", and they update as you place.
 */

const data = ref<any>(null);
const loading = ref(true);
const error = ref('');
const saving = ref(false);
const search = ref('');

/** The slot being filled. Never null: the board always has one slot in focus. */
const selectedRole = ref<string>(ROLES[0] as string);

const message = (e: any, fallback: string) =>
  e?.statusMessage || e?.data?.statusMessage || e?.data?.message || fallback;

async function load() {
  try {
    data.value = await $fetch<any>('/api/roster');
    error.value = '';
    // Open on the first hole, which is what someone arriving here wants to fix.
    const empty = ROLES.find((r) => !data.value?.roster?.[r]);
    if (empty) selectedRole.value = empty;
  } catch (e: any) {
    error.value = message(e, 'Could not load your roster.');
  } finally {
    loading.value = false;
  }
}

onMounted(load);

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

/** The card the preview is showing: whatever is in the slot you have selected. */
const previewCard = computed(() => slots.value[selectedRole.value]);
const previewHeld = computed(() => held(selectedRole.value));

/** Your cards for the selected role, best first. */
const bench = computed(() => {
  const role = selectedRole.value;
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

/** Which slot, if any, a card is already in — so the board can say so instead of duplicating it. */
const slotOf = (entryId: string) =>
  ROLES.find((r) => data.value?.roster?.[r]?.id === entryId) ?? null;

function select(role: string) {
  selectedRole.value = role;
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
      <span class="topbar__meta tnum">{{ filledCount }} / 5</span>
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

      <!-- the five, all visible at once -->
      <ul class="board">
        <li v-for="role in ROLES" :key="role">
          <button
            class="tile"
            :class="{ 'is-selected': selectedRole === role, 'is-empty': !slots[role] }"
            type="button"
            :aria-pressed="selectedRole === role"
            @click="select(role)"
          >
            <span class="tile__role">{{ role }}</span>

            <span v-if="slots[role]" class="tile__art">
              <LomCard :card="slots[role]" compact :interactive="false" />
            </span>
            <span v-else class="tile__hole" aria-hidden="true">+</span>

            <span class="tile__foot tnum" :class="slots[role] ? `is-${slots[role].rarity.toLowerCase()}` : ''">
              {{ slots[role] ? slots[role].ovr : '··' }}
            </span>

            <span v-if="chemistry.byRole[role].bonus" class="tile__chem tnum">
              +{{ chemistry.byRole[role].bonus }}
            </span>
          </button>
        </li>
      </ul>

      <!-- the slot in focus, full size -->
      <section class="preview">
        <template v-if="previewCard">
          <div class="preview__card">
            <LomCard :card="previewCard" />
          </div>
          <div class="preview__side">
            <p class="eyebrow">{{ selectedRole }}</p>
            <h2 class="preview__name">
              {{ previewCard.playerName }}
              <span v-if="previewCard.season" class="preview__season">{{ previewCard.season }}</span>
            </h2>
            <p class="muted preview__meta">
              {{ previewCard.team || 'Unknown team' }} · {{ depth(previewCard) }} champion{{ depth(previewCard) === 1 ? '' : 's' }} deep
              <template v-if="previewHeld?.level > 1"> · level {{ previewHeld.level }}</template>
            </p>
            <p v-if="chemistry.byRole[selectedRole].bonus" class="preview__chem">
              +{{ chemistry.byRole[selectedRole].bonus }} chemistry ·
              {{ chemistry.byRole[selectedRole].reasons.join(' · ') }}
            </p>
            <button class="btn btn--ghost preview__clear" type="button" :disabled="saving" @click="choose(selectedRole, null)">
              Take out of the lineup
            </button>
          </div>
        </template>
        <p v-else class="muted preview__empty">
          No {{ selectedRole }} picked. Choose one below.
        </p>
      </section>

      <!-- everything you own for that slot -->
      <section class="bench">
        <div class="bench__head">
          <p class="eyebrow">Your {{ selectedRole }} cards <span class="faint">({{ bench.length }})</span></p>
          <input
            v-model="search"
            class="bench__search"
            type="search"
            :placeholder="`Search ${selectedRole.toLowerCase()}s`"
          >
        </div>

        <ul v-if="bench.length" class="bench__grid">
          <li v-for="entry in bench" :key="entry.id">
            <button
              class="pick"
              :class="{ 'is-in': slotOf(entry.id) === selectedRole, 'is-elsewhere': slotOf(entry.id) && slotOf(entry.id) !== selectedRole }"
              type="button"
              :disabled="saving"
              @click="choose(selectedRole, entry)"
            >
              <LomCard :card="entry.card" compact :interactive="false" />
              <span class="pick__tag">
                <span class="tnum">{{ entry.card.ovr }}</span>
                <span v-if="slotOf(entry.id) === selectedRole">in</span>
                <span v-else-if="slotOf(entry.id)">{{ slotOf(entry.id) }}</span>
              </span>
            </button>
          </li>
        </ul>

        <p v-else class="muted bench__none">
          <template v-if="search">Nothing matches “{{ search }}”.</template>
          <template v-else>
            You own no {{ selectedRole }} cards yet. Open a pack, or buy a
            <NuxtLink to="/shop">Signing pack</NuxtLink> — five cards, one for every lane.
          </template>
        </p>
      </section>

      <section class="panel read">
        <p class="eyebrow">What this roster covers</p>
        <p class="read__line">
          <template v-if="coverage.champions">
            {{ coverage.champions }} champion{{ coverage.champions === 1 ? '' : 's' }} at mastery
            {{ DEPTH_MASTERY }} or better.
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

      <div class="foot">
        <NuxtLink class="btn btn--ghost" to="/replay">Watch these five play a match</NuxtLink>
        <p class="faint foot__note">
          A sandbox: nothing is at stake and no result is kept. Fixtures, strategy and
          the draft are what a roster feeds once matches land.
        </p>
      </div>
    </template>
  </main>
</template>

<style scoped>
.sheet-skeleton { height: 60vh; }

.totals { display: flex; justify-content: space-between; gap: 10px; }
.totals__cell { text-align: center; flex: 1; }
.totals__n { font-size: 22px; font-weight: 700; }
.totals__n.is-on { color: var(--good, #7df0dc); }

/* --- the board ----------------------------------------------------------- */

.board {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 6px;
  list-style: none;
  padding: 0;
  margin: 14px 0 0;
}

.tile {
  position: relative;
  width: 100%;
  display: grid;
  gap: 4px;
  justify-items: center;
  padding: 6px 4px 5px;
  border-radius: 10px;
  border: 1px solid var(--line, #2b3448);
  background: var(--surface-1, #141a26);
  cursor: pointer;
  transition: border-color 0.15s, transform 0.15s, background 0.15s;
}
.tile:hover { border-color: var(--line-bright, #49566b); }
.tile.is-selected {
  border-color: var(--accent, #67d3f2);
  background: var(--surface-2, #1b2230);
  transform: translateY(-2px);
}
.tile.is-empty { border-style: dashed; }

.tile__role {
  font-size: 9px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink-dim, #8fa3c0);
}
/* The card engine sizes itself: width 100% of its host, aspect-ratio 63/88, with the art
   deliberately overflowing the frame and cropped. Constrain the host and nothing else —
   forcing width on the inner img fights card.css and flattens the artwork. */
.tile__art { display: block; width: 100%; }

.tile__hole {
  display: grid;
  place-items: center;
  width: 100%;
  aspect-ratio: 5 / 7;
  font-size: 20px;
  color: var(--ink-dim, #8fa3c0);
  opacity: 0.5;
}

.tile__foot { font-size: 12px; font-weight: 700; }
.tile__foot.is-common { color: #8fa3c0; }
.tile__foot.is-rare { color: #67d3f2; }
.tile__foot.is-epic { color: #c08cff; }
.tile__foot.is-legendary { color: #f5cf6a; }
.tile__foot.is-icon { color: #7df0dc; }

.tile__chem {
  position: absolute;
  top: 4px;
  right: 4px;
  font-size: 9px;
  font-weight: 700;
  color: var(--good, #7df0dc);
}

/* --- preview ------------------------------------------------------------- */

.preview {
  display: grid;
  gap: 12px;
  margin-top: 14px;
  padding: 12px;
  border-radius: 12px;
  background: var(--surface-1, #141a26);
  border: 1px solid var(--line, #2b3448);
}
.preview__card { max-width: 240px; margin: 0 auto; width: 100%; }
.preview__side { display: grid; gap: 4px; align-content: start; }
.preview__name { font-size: 19px; }
.preview__season { color: var(--ink-dim, #8fa3c0); font-weight: 400; }
.preview__meta { font-size: 13px; }
.preview__chem { font-size: 13px; color: var(--good, #7df0dc); }
.preview__clear { margin-top: 8px; justify-self: start; }
.preview__empty { text-align: center; padding: 20px 0; }

@media (min-width: 620px) {
  .preview { grid-template-columns: 240px 1fr; align-items: start; }
  .preview__card { margin: 0; }
}

/* --- bench --------------------------------------------------------------- */

.bench { margin-top: 16px; }
.bench__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.bench__search {
  flex: 0 1 180px;
  min-width: 0;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--line, #2b3448);
  background: var(--surface-1, #141a26);
  color: var(--ink, #e4ebf6);
  font: inherit;
  font-size: 13px;
}

.bench__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
  gap: 8px;
  list-style: none;
  padding: 0;
  margin: 0;
}

.pick {
  position: relative;
  width: 100%;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 10px;
  background: none;
  cursor: pointer;
  transition: transform 0.12s, border-color 0.12s;
}
.pick:hover { transform: translateY(-2px); }
.pick:disabled { cursor: progress; opacity: 0.7; }
.pick.is-in { border-color: var(--accent, #67d3f2); }
.pick.is-elsewhere { opacity: 0.55; }
.pick :deep(.lom-card-host) { display: block; width: 100%; }

.pick__tag {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  justify-content: center;
  gap: 4px;
  padding: 2px 0 3px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink, #e4ebf6);
  background: linear-gradient(to top, rgba(6, 10, 16, 0.92), rgba(6, 10, 16, 0));
  border-radius: 0 0 8px 8px;
}

.bench__none { padding: 16px 0; text-align: center; font-size: 13px; }

/* --- readouts ------------------------------------------------------------ */

.read { margin-top: 16px; }
.read__line { font-size: 13px; }
.read__eyebrow { margin-top: 10px; }
.read__chem { list-style: none; padding: 0; margin: 4px 0 0; font-size: 13px; display: grid; gap: 2px; }

.foot { margin-top: 18px; display: grid; gap: 8px; justify-items: center; text-align: center; }
.foot__note { font-size: 12px; max-width: 42ch; }
</style>
