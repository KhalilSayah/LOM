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
  playSound(entry ? 'slotIn' : 'back');

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

/**
 * The strongest card you own for every lane. Chemistry is left to the person: it trades
 * rating for links, and that trade is the interesting decision on this screen, so the
 * shortcut only does the obvious part.
 */
const bestFive = computed<Record<string, any>>(() => {
  const out: Record<string, any> = {};
  for (const role of ROLES) {
    out[role] = owned.value
      .filter((c) => c.card.role === role)
      .sort((a, b) => b.card.ovr - a.card.ovr || (b.level ?? 1) - (a.level ?? 1))[0] ?? null;
  }
  return out;
});

/** Slots the shortcut would change. Empty when the five already is the best five. */
const autofillChanges = computed(() =>
  ROLES.filter((r) => bestFive.value[r] && held(r)?.id !== bestFive.value[r].id));

async function autofill() {
  if (saving.value || !autofillChanges.value.length) return;
  const changes = [...autofillChanges.value];
  for (const role of changes) data.value.roster[role] = bestFive.value[role];
  playSound('slotIn');

  saving.value = true;
  try {
    for (const role of changes) {
      await $fetch('/api/roster/slot', {
        method: 'POST',
        body: { role, collectionCardId: bestFive.value[role].id },
      });
    }
    error.value = '';
    if (chemistry.value.average > 0) playSound('chemistry');
  } catch (e: any) {
    error.value = message(e, 'Some of that did not save.');
  } finally {
    saving.value = false;
    await load();
  }
}

/**
 * Where each role stands on the board: its lane on the Rift, blue base bottom-left.
 * Top up the left edge, jungle between the lanes, mid on the diagonal, bot and support
 * along the bottom. A formation a League player reads without a legend.
 */
const LANE_AT: Record<string, { x: number; y: number }> = {
  TOP: { x: 19, y: 22 },
  JNG: { x: 22, y: 62 },
  MID: { x: 50, y: 44 },
  BOT: { x: 81, y: 79 },
  SUP: { x: 59, y: 81 },
};

/** Lines between cards that earn chemistry from the same reason — the core made visible. */
const links = computed(() => {
  const out: Array<{ a: string; b: string }> = [];
  for (let i = 0; i < ROLES.length; i++) {
    for (let j = i + 1; j < ROLES.length; j++) {
      const a = ROLES[i] as string;
      const b = ROLES[j] as string;
      const ra = chemistry.value.byRole[a]?.reasons ?? [];
      const rb = chemistry.value.byRole[b]?.reasons ?? [];
      if (slots.value[a] && slots.value[b] && ra.some((r: string) => rb.includes(r))) out.push({ a, b });
    }
  }
  return out;
});

/** A chemistry bonus earned by a swap is worth hearing. */
watch(() => chemistry.value.average, (now, before) => {
  if (!loading.value && before !== undefined && now > before) setTimeout(() => playSound('chemistry'), 140);
});

useHead({ title: 'Team — LOM' });
</script>


<template>
  <main class="page page--full team">
    <header class="topbar">
      <h1>Team</h1>
      <span class="topbar__meta tnum">{{ filledCount }} of 5 set</span>
      <button
        v-if="data && autofillChanges.length"
        class="btn btn--ghost btn--sm team__auto" type="button" data-sound="none"
        :disabled="saving" @click="autofill"
      >
        {{ filledCount < 5 ? 'Fill with my best' : 'Use my best five' }}
      </button>
    </header>

    <p v-if="error" class="notice notice--bad" role="alert">{{ error }}</p>

    <div v-if="loading" class="skeleton team__skeleton" />

    <template v-else-if="data">
      <div class="team__grid">
        <section class="team__board">
          <dl class="totals">
            <div><dt>Rating</dt><dd class="num">{{ rating || '—' }}</dd></div>
            <div><dt>Chemistry</dt><dd class="num" :class="{ 'is-on': chemistry.average > 0 }">{{ chemistry.average ? `+${chemistry.average}` : '—' }}</dd></div>
            <div><dt>Pool</dt><dd class="num">{{ coverage.champions || '—' }}</dd></div>
          </dl>

          <!-- the five, placed where they play -->
          <div class="rift">
            <img class="rift__map" src="/map/rift.jpg" alt="" aria-hidden="true">
            <svg class="rift__links" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <line
                v-for="l in links" :key="`${l.a}-${l.b}`"
                :x1="LANE_AT[l.a]!.x" :y1="LANE_AT[l.a]!.y" :x2="LANE_AT[l.b]!.x" :y2="LANE_AT[l.b]!.y"
              />
            </svg>

            <button
              v-for="role in ROLES" :key="role"
              class="slot"
              :class="{ 'is-selected': selectedRole === role, 'is-empty': !slots[role] }"
              :style="{ left: `${LANE_AT[role]!.x}%`, top: `${LANE_AT[role]!.y}%` }"
              type="button"
              :aria-pressed="selectedRole === role"
              :aria-label="`${role}: ${slots[role] ? `${slots[role].playerName} ${slots[role].season}` : 'empty'}`"
              @click="select(role)"
            >
              <LomCard v-if="slots[role]" :card="slots[role]" compact :interactive="false" />
              <span v-else class="slot__hole" aria-hidden="true">+</span>
              <span class="slot__tags">
                <span class="tag slot__role" :class="{ 'is-sel': selectedRole === role }">{{ role }}</span>
                <span v-if="chemistry.byRole[role]!.bonus" class="slot__chem tnum">+{{ chemistry.byRole[role]!.bonus }}</span>
              </span>
            </button>
          </div>

          <p class="read">
            <template v-if="coverage.champions">
              {{ coverage.champions }} champion{{ coverage.champions === 1 ? '' : 's' }} at mastery {{ DEPTH_MASTERY }}+ across the five.
              <template v-if="coverage.weakest">Thinnest: {{ coverage.weakest.role }}, with {{ coverage.weakest.champions }}.</template>
            </template>
            <template v-else>Fill a slot and the combined champion pool shows up here.</template>
          </p>
          <ul v-if="chemistry.cores.length || chemistry.teamWide.length" class="chem">
            <li v-for="core in chemistry.cores" :key="core.label"><b>{{ core.label }}</b> ×{{ core.size }}<span>+{{ core.bonus }} each</span></li>
            <li v-for="line in chemistry.teamWide" :key="line"><b>{{ line }}</b><span>+1 each</span></li>
          </ul>
          <p v-else-if="filledCount > 1" class="read faint">
            No chemistry yet. Two cards from the same real team and season are +1.5 each, three or more +2.5,
            and a full five sharing a region or a year +1 on top.
          </p>
        </section>

        <section class="team__side">
          <!-- the slot in focus -->
          <div class="focus">
            <template v-if="previewCard">
              <div class="focus__card"><LomCard :card="previewCard" /></div>
              <div class="focus__text">
                <p class="label">{{ selectedRole }}</p>
                <h2 class="focus__name">
                  {{ previewCard.playerName }} <span v-if="previewCard.season" class="focus__year">{{ previewCard.season }}</span>
                </h2>
                <p class="muted focus__meta">
                  {{ previewCard.team || 'Unknown team' }} · {{ depth(previewCard) }} champion{{ depth(previewCard) === 1 ? '' : 's' }} deep
                  <template v-if="previewHeld?.level > 1"> · level {{ previewHeld.level }}</template>
                </p>
                <p v-if="chemistry.byRole[selectedRole]!.bonus" class="focus__chem">
                  +{{ chemistry.byRole[selectedRole]!.bonus }} chemistry · {{ chemistry.byRole[selectedRole]!.reasons.join(' · ') }}
                </p>
                <button class="btn btn--quiet" type="button" :disabled="saving" @click="choose(selectedRole, null)">
                  Take out
                </button>
              </div>
            </template>
            <p v-else class="muted focus__empty">No {{ selectedRole }} in the five. Choose one below.</p>
          </div>

          <!-- everything you own for that slot -->
          <div class="bench">
            <div class="bench__head">
              <h2>Your {{ selectedRole }} cards <span class="faint tnum">{{ bench.length }}</span></h2>
              <input v-model="search" class="input bench__search" type="search" :placeholder="`Search your ${selectedRole} cards`" :aria-label="`Search your ${selectedRole} cards`">
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
                    <template v-if="slotOf(entry.id) === selectedRole">In the five</template>
                    <template v-else-if="slotOf(entry.id)">At {{ slotOf(entry.id) }}</template>
                  </span>
                </button>
              </li>
            </ul>

            <p v-else class="muted bench__none">
              <template v-if="search">Nothing matches “{{ search }}”.</template>
              <template v-else>
                You own no {{ selectedRole }} cards yet. Open a pack, or buy a
                <NuxtLink to="/shop">Signing pack</NuxtLink>: five cards, one for every lane.
              </template>
            </p>
          </div>

          <div class="foot">
            <NuxtLink class="btn btn--ghost" to="/replay">Watch these five play</NuxtLink>
            <p class="faint">A sandbox match: nothing is at stake and no result is kept.</p>
          </div>
        </section>
      </div>
    </template>
  </main>
</template>

<style scoped>
.team__skeleton { height: 520px; }
.team .topbar__meta { margin-left: auto; }
.team__auto { flex: none; }
.team__grid { display: grid; gap: 28px; }

.totals { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 0 0 14px; border-top: 1px solid var(--line-1); border-bottom: 1px solid var(--line-1); }
.totals div { padding: 12px 0 12px 14px; border-left: 1px solid var(--line-1); }
.totals div:first-child { border-left: 0; padding-left: 0; }
.totals dt { font-size: 12px; color: var(--ink-3); }
.totals dd { margin: 4px 0 0; font-size: 28px; }
.totals dd.is-on { color: var(--gold-1); }

/* --- the Rift --------------------------------------------------------------- */
.rift {
  position: relative;
  aspect-ratio: 1;
  overflow: hidden;
  border-radius: var(--radius);
  background: #060a11;
  box-shadow: inset 0 0 0 1px var(--line-2);
}
.rift__map { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0.3; filter: saturate(0.45) brightness(0.8); }
.rift::after { content: ''; position: absolute; inset: 0; background: radial-gradient(75% 75% at 50% 50%, transparent 40%, rgba(5, 8, 13, 0.85)); pointer-events: none; }
.rift__links { position: absolute; inset: 0; z-index: 1; width: 100%; height: 100%; }
.rift__links line { stroke: var(--gold-2); stroke-width: 1.5; stroke-dasharray: 4 4; opacity: 0.75; vector-effect: non-scaling-stroke; }

.slot {
  position: absolute;
  z-index: 2;
  width: 19.5%;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  cursor: pointer;
  translate: -50% -50%;
  transition: transform 160ms var(--ease-out);
}
.slot :deep(.lom-card) { transition: box-shadow 160ms ease; }
.slot.is-selected :deep(.lom-card) { box-shadow: 0 0 0 2px var(--gold-2), 0 10px 24px rgba(0, 0, 0, 0.6); }
.slot__hole {
  display: grid;
  place-items: center;
  aspect-ratio: 63 / 88;
  border: 1px dashed var(--line-3);
  border-radius: 4%;
  background: rgba(4, 7, 13, 0.7);
  font-size: 24px;
  color: var(--ink-3);
}
.slot.is-selected .slot__hole { border-color: var(--gold-2); color: var(--gold-1); }
/* Role and chemistry sit in a strip above the card, never on its name or year. */
.slot__tags { position: absolute; left: -12px; right: -12px; bottom: calc(100% + 5px); z-index: 3; display: flex; justify-content: center; align-items: center; gap: 3px; }
.slot__role.is-sel { --tag: var(--gold-2); color: var(--gold-ink); }
.slot__chem {
  padding: 1px 5px;
  border: 1px solid rgba(216, 176, 100, 0.5);
  border-radius: 2px;
  background: var(--bg-0);
  font-size: 10.5px;
  font-weight: 800;
  color: var(--gold-1);
}
@media (hover: hover) and (pointer: fine) { .slot:hover { transform: translateY(-3px); } }

.read { margin: 14px 0 0; font-size: 13.5px; color: var(--ink-2); }
.chem { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 6px; }
.chem li { display: flex; gap: 8px; align-items: baseline; font-size: 13.5px; color: var(--ink-2); }
.chem b { color: var(--ink-1); font-weight: 680; }
.chem span { margin-left: auto; color: var(--gold-1); font-weight: 700; font-variant-numeric: tabular-nums; }

/* --- focus + bench ---------------------------------------------------------- */
.focus { display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 18px; align-items: center; padding-bottom: 22px; border-bottom: 1px solid var(--line-1); }
.focus__name { margin: 4px 0 0; font-size: 26px; line-height: 1; }
.focus__year { color: var(--gold-1); }
.focus__meta { margin: 6px 0 0; font-size: 13px; }
.focus__chem { margin: 6px 0 12px; font-size: 13px; color: var(--gold-1); }
.focus__text .btn { margin-top: 12px; }
.focus__empty { grid-column: 1 / -1; margin: 0; padding: 22px 0 0; }

.bench { margin-top: 22px; }
.bench__head { display: grid; gap: 10px; margin-bottom: 14px; }
.bench__head h2 { font-stretch: 92%; font-weight: 720; font-size: 17px; }
.bench__search { min-height: 44px; font-size: 15px; }
.bench__grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 22px 10px; }
.pick { position: relative; display: block; width: 100%; padding: 0; border: 0; background: none; color: inherit; cursor: pointer; }
.pick.is-in :deep(.lom-card) { box-shadow: 0 0 0 2px var(--gold-2); }
.pick.is-elsewhere { opacity: 0.55; }
.pick__tag { display: block; min-height: 16px; margin-top: 6px; font-size: 11.5px; font-weight: 650; color: var(--ink-3); text-align: center; }
.pick.is-in .pick__tag { color: var(--gold-1); }
.bench__none { font-size: 14px; }

.foot { display: grid; gap: 8px; justify-items: start; margin-top: 28px; padding-top: 20px; border-top: 1px solid var(--line-1); }
.foot p { margin: 0; font-size: 12.5px; }

@media (min-width: 1024px) {
  .team__grid { grid-template-columns: minmax(0, 560px) minmax(0, 1fr); gap: 40px; align-items: start; }
  .focus { grid-template-columns: 180px minmax(0, 1fr); }
  .bench__head { grid-template-columns: minmax(0, 1fr) 240px; align-items: center; }
}

@media (prefers-reduced-motion: reduce) { .slot, .slot :deep(.lom-card) { transition: none; } }
</style>
