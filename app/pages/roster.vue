<script setup lang="ts">
import {
  ROLES, coverageFor, matchRatingFor, readSwap, bestLineup, nearMisses, banRisk,
  STRATEGIES, DEFAULT_STRATEGY, strategyEffects, slotForRole, DEPTH_MASTERY,
  type LineupPlan, type NearMiss, type RosterCard,
} from '~~/shared/roster';
import { BALANCE } from '~~/packages/sim/src/balance.js';

/**
 * The roster: five slots, one per role, filled from cards you own.
 *
 * This was a list of text rows, which is how docs/09 section 6 sketches it. The sketch is
 * wrong for this game. A lineup in a collecting game is the thing you show people, and five
 * rows of "Zeus 2023 · 86" show nothing — the art, the frame and the rarity are most of why
 * a card is worth owning, and none of them survive being flattened into a row.
 *
 * So it is a board: five slots you can see at once, your cards underneath, tap one to see
 * what it would do. Tapping a slot selects it rather than opening a modal, because a modal
 * hides the board you are trying to build and makes comparing two options a round trip.
 *
 * Nothing saves on a tap. A bench card is staged into the slot first — on the map, in the
 * focus panel, and as deltas on the three numbers — and only Confirm writes it. The same
 * goes for "use my best five": it shows the plan and what it gains before anything moves.
 *
 * The headline is the match rating: what the engine actually feeds into every contest for
 * these five (shared/roster.ts matchRatingFor), not an OVR average that ignores levels,
 * mastery and chemistry.
 */

const data = ref<any>(null);
const loading = ref(true);
const error = ref('');
const saving = ref(false);
const search = ref('');

/** The slot being filled. Never null: the board always has one slot in focus. */
const selectedRole = ref<string>(ROLES[0] as string);

/** A bench card shown in its slot but not saved, waiting for Confirm. */
const staged = ref<{ role: string; entry: any } | null>(null);
/** The "use my best five" plan, shown before it is applied. */
const plan = ref<LineupPlan | null>(null);

type SortKey = 'fit' | 'ovr' | 'chem';
const sortBy = ref<SortKey>('fit');
const SORTS: { id: SortKey; label: string }[] = [
  { id: 'fit', label: 'Match rating' },
  { id: 'ovr', label: 'OVR' },
  { id: 'chem', label: 'Chemistry' },
];

/** The chemistry link whose reason is showing under the map. */
const activeLink = ref<string | null>(null);

const strategy = ref<string>(DEFAULT_STRATEGY);
const savingStrategy = ref(false);

const message = (e: any, fallback: string) =>
  e?.statusMessage || e?.data?.statusMessage || e?.data?.message || fallback;

const round1 = (n: number) => Math.round(n * 10) / 10;
/** "+1.2", "−0.8", "±0": the sign carries the meaning, the colour only repeats it. */
const signed = (n: number | null | undefined) => {
  const v = round1(Number(n) || 0);
  return v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : '±0';
};
const tone = (n: number | null | undefined) => {
  const v = round1(Number(n) || 0);
  return v > 0 ? 'is-up' : v < 0 ? 'is-down' : '';
};

/**
 * Load the roster. `keepError` is for the reload after a failed save: the save's message is
 * the one worth reading, so a reload that also fails must not replace it.
 */
async function load(keepError = false) {
  try {
    const fresh = await $fetch<any>('/api/roster');
    data.value = fresh;
    strategy.value = fresh?.strategy || DEFAULT_STRATEGY;
    if (!keepError) error.value = '';
  } catch (e: any) {
    if (!keepError || !error.value) error.value = message(e, 'Could not load your roster.');
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await load();
  // Open on the first hole, which is what someone arriving here wants to fix.
  const empty = ROLES.find((r) => !data.value?.roster?.[r]);
  if (empty) selectedRole.value = empty;
  window.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && (staged.value || plan.value)) cancelPreview();
}

// --- what is on the board ----------------------------------------------------------

const entries = computed<Record<string, any>>(() => {
  const out: Record<string, any> = {};
  for (const role of ROLES) out[role] = data.value?.roster?.[role] ?? null;
  return out;
});

const cardsOf = (e: Record<string, any>) => {
  const out: Record<string, RosterCard | null> = {};
  for (const role of ROLES) out[role] = e[role]?.card ?? null;
  return out;
};

const slots = computed(() => cardsOf(entries.value));
const owned = computed<any[]>(() => data.value?.owned ?? []);
const filledCount = computed(() => ROLES.filter((r) => slots.value[r]).length);
const missingRoles = computed(() => ROLES.filter((r) => !slots.value[r]));

const rating = computed(() => matchRatingFor(slots.value));
const chemistry = computed(() => rating.value.chemistry);
const coverage = computed(() => coverageFor(slots.value));

/**
 * The lineup being previewed — one staged swap, or the whole best-five plan — with what it
 * changes. Null when nothing is staged, and then the board shows what is saved.
 */
const preview = computed(() => {
  let view: Record<string, RosterCard | null> | null = null;
  let changed: string[] = [];
  if (staged.value) {
    view = { ...slots.value, [staged.value.role]: staged.value.entry.card };
    changed = [staged.value.role];
  } else if (plan.value?.changes.length) {
    view = cardsOf(plan.value.slots);
    changed = plan.value.changes;
  }
  if (!view) return null;

  const r = matchRatingFor(view);
  return {
    slots: view,
    rating: r,
    changed: new Set(changed),
    delta: {
      matchRating: round1(r.value - rating.value.value),
      chemistry: round1(r.chemistry.average - chemistry.value.average),
      pool: coverageFor(view).champions - coverage.value.champions,
    },
  };
});

/** What the map and the focus panel draw: the preview when there is one. */
const shown = computed(() => preview.value?.slots ?? slots.value);
const shownRating = computed(() => preview.value?.rating ?? rating.value);
const shownChem = computed(() => shownRating.value.chemistry);

const focusCard = computed(() => shown.value[selectedRole.value]);
const focusStaged = computed(() => preview.value?.changed.has(selectedRole.value) ?? false);
/** The card carries its owned level (shared/cardShape.ts toCard), staged or saved alike. */
const focusLevel = computed(() => focusCard.value?.level ?? 1);
const focusPlayer = computed(() => shownRating.value.byRole[selectedRole.value]);

/** The staged swap read on its own, for the milestone line in the tray. */
const stagedSwap = computed(() => staged.value ? readSwap(slots.value, staged.value.role, staged.value.entry.card) : null);

const risks = computed(() => banRisk(shown.value));
const hints = computed<NearMiss[]>(() => nearMisses(entries.value, owned.value));

const depth = (card: any) =>
  (card?.championPool || []).filter((p: any) => p.mastery >= DEPTH_MASTERY).length;

// --- the bench -------------------------------------------------------------------------

const inFive = (entryId: string) => entries.value[selectedRole.value]?.id === entryId;

/**
 * Your cards for the selected lane, each read against the five as they stand: what it
 * would do to the match rating, the chemistry it would bring and with whom.
 */
const bench = computed(() => {
  const role = selectedRole.value;
  const q = search.value.trim().toLowerCase();

  const rows = owned.value
    .filter((c) => slotForRole(c.card.role) === role)
    .filter((c) => {
      if (!q) return true;
      const hay = `${c.card.playerName} ${c.card.team} ${c.card.season} `
        + c.card.championPool.map((p: any) => p.champion).join(' ');
      return hay.toLowerCase().includes(q);
    })
    .map((entry) => ({
      entry,
      held: inFive(entry.id),
      swap: readSwap(slots.value, role, entry.card),
    }));

  const by: Record<SortKey, (a: any, b: any) => number> = {
    fit: (a, b) => b.swap.matchRating - a.swap.matchRating,
    ovr: (a, b) => b.entry.card.ovr - a.entry.card.ovr || (b.entry.level ?? 1) - (a.entry.level ?? 1),
    chem: (a, b) => b.swap.teamChemistry - a.swap.teamChemistry || b.swap.bonus - a.swap.bonus,
  };
  // The card already in the slot reads ±0 on every axis, so it sorts by OVR among equals.
  return rows.sort((a, b) => by[sortBy.value](a, b) || by.ovr(a, b));
});

function select(role: string) {
  selectedRole.value = role;
  search.value = '';
  if (staged.value && staged.value.role !== role) staged.value = null;
}

function stage(entry: any) {
  if (saving.value) return;
  plan.value = null;
  if (inFive(entry.id)) { staged.value = null; return; }
  staged.value = { role: selectedRole.value, entry };
}

function takeHint(hint: NearMiss) {
  if (!hint.entry) return;
  selectedRole.value = hint.role;
  search.value = '';
  plan.value = null;
  staged.value = { role: hint.role, entry: hint.entry };
}

function cancelPreview() {
  staged.value = null;
  plan.value = null;
}

/** Plays the chemistry chime once, and only when the five actually gained some. */
function chimeIfChemistryRose(before: number) {
  if (chemistry.value.average > before) setTimeout(() => playSound('chemistry'), 140);
}

async function choose(role: string, entry: any | null) {
  if (saving.value) return;

  const before = data.value.roster[role];
  const chemBefore = chemistry.value.average;
  data.value.roster[role] = entry;
  staged.value = null;
  playSound(entry ? 'slotIn' : 'back');
  chimeIfChemistryRose(chemBefore);

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
    await load(true);
  } finally {
    saving.value = false;
  }
}

async function confirmStage() {
  if (!staged.value) return;
  await choose(staged.value.role, staged.value.entry);
}

// --- use my best five ------------------------------------------------------------------

function openPlan() {
  staged.value = null;
  plan.value = bestLineup(owned.value, entries.value);
}

/**
 * Apply the plan in one request (/api/roster/lineup), which writes every slot or none. On
 * failure the board goes back to exactly what it was, and the reload that follows keeps
 * the save's error rather than its own.
 */
async function applyPlan() {
  const p = plan.value;
  if (saving.value || !p?.changes.length) return;

  const snapshot = { ...data.value.roster };
  const chemBefore = chemistry.value.average;
  const body: Record<string, string> = {};
  for (const role of p.changes) {
    data.value.roster[role] = p.slots[role];
    body[role] = p.slots[role]!.id;
  }
  plan.value = null;
  playSound('slotIn');
  chimeIfChemistryRose(chemBefore);

  saving.value = true;
  try {
    await $fetch('/api/roster/lineup', { method: 'POST', body: { slots: body } });
    error.value = '';
  } catch (e: any) {
    data.value.roster = snapshot;
    error.value = message(e, 'Nothing changed: the new five did not save.');
    await load(true);
  } finally {
    saving.value = false;
  }
}

const planName = (entry: any) => entry ? `${entry.card.playerName}${entry.card.season ? ` ${entry.card.season}` : ''}` : 'empty';

// --- strategy --------------------------------------------------------------------------

const strategies = computed(() => STRATEGIES
  .filter((s) => (BALANCE.strategy as Record<string, unknown>)[s.id] !== undefined)
  .map((s) => {
    const effects = strategyEffects((BALANCE.strategy as Record<string, any>)[s.id]);
    const list = effects.length ? `${effects.join(', ')}.` : 'No modifiers.';
    return { ...s, effects: list.charAt(0).toUpperCase() + list.slice(1) };
  }));
const currentStrategy = computed(() => strategies.value.find((s) => s.id === strategy.value) ?? strategies.value[0]);

async function setStrategy(id: string) {
  if (savingStrategy.value || id === strategy.value) return;
  const before = strategy.value;
  strategy.value = id;
  savingStrategy.value = true;
  try {
    await $fetch('/api/roster/strategy', { method: 'POST', body: { strategy: id } });
    error.value = '';
  } catch (e: any) {
    strategy.value = before;
    error.value = message(e, 'The strategy did not save.');
  } finally {
    savingStrategy.value = false;
  }
}

// --- the map ---------------------------------------------------------------------------

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

/**
 * Lines between cards that shared a real team in the same season — the cores, made visible.
 *
 * A core is drawn as a chain through its members in lane order, not a full mesh, and the
 * team-wide bonuses (all one region, all one year) are not lines at all: every card has
 * them, so a line between every pair would say nothing and bury the cores. They sit as tags
 * in the corner of the map instead. Each core carries one tappable marker with its bonus.
 */
const cores = computed(() => {
  const groups = new Map<string, string[]>();
  for (const role of ROLES) {
    const c = shown.value[role];
    if (!c?.team || !c?.season) continue;
    const k = `${c.team}|${c.season}`;
    groups.set(k, [...(groups.get(k) || []), role]);
  }
  return [...groups.entries()]
    .filter(([, roles]) => roles.length >= 2)
    .map(([k, roles]) => {
      const [team, season] = k.split('|');
      const segments = roles.slice(1).map((b, i) => ({ a: roles[i]!, b }));
      const first = segments[0]!;
      return {
        key: k,
        label: `${team} ${season}`,
        roles,
        bonus: roles.length >= 3 ? 2.5 : 1.5,
        segments,
        at: { x: (LANE_AT[first.a]!.x + LANE_AT[first.b]!.x) / 2, y: (LANE_AT[first.a]!.y + LANE_AT[first.b]!.y) / 2 },
      };
    });
});

const linkReason = computed(() => {
  const key = activeLink.value;
  if (!key) return null;
  const core = cores.value.find((c) => c.key === key);
  if (core) {
    const names = core.roles.map((r) => shown.value[r]?.playerName).filter(Boolean);
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
    return `${core.label} ×${core.roles.length}: ${list} played together that season. `
      + `${core.roles.length >= 3 ? 'A core of three or more' : 'A duo'} is +${core.bonus} chemistry each.`;
  }
  if (shownChem.value.teamWide.includes(key)) {
    const what = key.replace(/^All /, '');
    return /^\d{4}$/.test(what)
      ? `All five cards are from ${what}: +1 chemistry each, on top of any core.`
      : `All five play in the ${what}: +1 chemistry each, on top of any core.`;
  }
  return null;
});

// A link that no longer exists (the card moved) stops explaining itself.
watch(linkReason, (r) => { if (!r) activeLink.value = null; });

const toggleLink = (key: string) => { activeLink.value = activeLink.value === key ? null : key; };

useHead({ title: 'Team — LOM' });
</script>


<template>
  <main class="page page--full team" :class="{ 'has-tray': staged || plan }">
    <header class="topbar">
      <h1>Team</h1>
      <span class="topbar__meta tnum">{{ filledCount }} of 5 set</span>
      <button
        v-if="data && owned.length"
        class="btn btn--ghost btn--sm team__auto" type="button"
        :disabled="saving" @click="openPlan"
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
            <div class="totals__main">
              <dt>Match rating</dt>
              <dd>
                <span class="num">{{ rating.value || '—' }}</span>
                <span v-if="preview" class="ghost tnum" :class="tone(preview.delta.matchRating)">{{ signed(preview.delta.matchRating) }}</span>
              </dd>
              <p class="totals__why">
                Each player's OVR and level, times mastery on their best champion, plus chemistry.
                The number the match plays.<template v-if="filledCount && filledCount < 5"> Average of the {{ filledCount }} set.</template>
              </p>
            </div>
            <div>
              <dt>Chemistry</dt>
              <dd>
                <span class="num" :class="{ 'is-on': chemistry.average > 0 }">{{ chemistry.average ? `+${chemistry.average}` : '—' }}</span>
                <span v-if="preview" class="ghost tnum" :class="tone(preview.delta.chemistry)">{{ signed(preview.delta.chemistry) }}</span>
              </dd>
              <p class="totals__why">Average bonus per player from shared teams, regions and years.</p>
            </div>
            <div>
              <dt>Pool</dt>
              <dd>
                <span class="num">{{ coverage.champions || '—' }}</span>
                <span v-if="preview" class="ghost tnum" :class="tone(preview.delta.pool)">{{ signed(preview.delta.pool) }}</span>
              </dd>
              <p class="totals__why">Champions the five play at mastery {{ DEPTH_MASTERY }}+. Deeper is harder to ban out.</p>
            </div>
          </dl>

          <!-- the five, placed where they play -->
          <div class="rift">
            <img class="rift__map" src="/map/rift.jpg" alt="" aria-hidden="true">
            <svg class="rift__links" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <template v-for="core in cores" :key="core.key">
                <line
                  v-for="s in core.segments" :key="`${s.a}-${s.b}`"
                  :class="{ 'is-active': activeLink === core.key }"
                  :x1="LANE_AT[s.a]!.x" :y1="LANE_AT[s.a]!.y" :x2="LANE_AT[s.b]!.x" :y2="LANE_AT[s.b]!.y"
                />
              </template>
            </svg>

            <button
              v-for="role in ROLES" :key="role"
              class="slot"
              :class="{ 'is-selected': selectedRole === role, 'is-empty': !shown[role], 'is-staged': preview?.changed.has(role) }"
              :style="{ left: `${LANE_AT[role]!.x}%`, top: `${LANE_AT[role]!.y}%` }"
              type="button"
              :aria-pressed="selectedRole === role"
              :aria-label="`${role}: ${shown[role] ? `${shown[role]!.playerName} ${shown[role]!.season ?? ''}` : 'empty'}${preview?.changed.has(role) ? ', preview' : ''}`"
              @click="select(role)"
            >
              <LomCard v-if="shown[role]" :card="shown[role]" compact :interactive="false" />
              <span v-else class="slot__hole" aria-hidden="true">+</span>
              <span class="slot__tags">
                <span class="tag slot__role" :class="{ 'is-sel': selectedRole === role }">{{ role }}</span>
                <span v-if="shownChem.byRole[role]!.bonus" class="slot__chem tnum">+{{ shownChem.byRole[role]!.bonus }}</span>
              </span>
            </button>

            <button
              v-for="core in cores" :key="`m-${core.key}`"
              class="rift__mark tnum" type="button"
              :class="{ 'is-active': activeLink === core.key }"
              :style="{ left: `${core.at.x}%`, top: `${core.at.y}%` }"
              :aria-pressed="activeLink === core.key"
              :aria-label="`${core.label} chemistry, +${core.bonus} each. Show why`"
              @click="toggleLink(core.key)"
            >
              +{{ core.bonus }}
            </button>

            <div v-if="shownChem.teamWide.length" class="rift__wide">
              <button
                v-for="line in shownChem.teamWide" :key="line"
                class="rift__wideTag" type="button"
                :class="{ 'is-active': activeLink === line }"
                :aria-pressed="activeLink === line"
                @click="toggleLink(line)"
              >
                {{ line }} <b class="tnum">+1</b>
              </button>
            </div>
          </div>

          <p v-if="linkReason" class="read link-reason" role="status">{{ linkReason }}</p>
          <p v-else-if="cores.length || shownChem.teamWide.length" class="read faint">Tap a chemistry marker on the map to see why it pays.</p>

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

          <!-- one card away -->
          <section v-if="hints.length" class="block">
            <h2 class="label">Near misses</h2>
            <ul class="hints">
              <li v-for="hint in hints" :key="hint.text">
                <button class="hint" type="button" :disabled="!hint.entry || saving" @click="takeHint(hint)">
                  <span class="hint__text">{{ hint.text }}</span>
                  <span v-if="hint.delta !== null" class="hint__delta tnum" :class="tone(hint.delta)">{{ signed(hint.delta) }}</span>
                </button>
              </li>
            </ul>
          </section>

          <!-- where bans hurt -->
          <section v-if="filledCount" class="block">
            <h2 class="label">Ban risk</h2>
            <ul class="risks">
              <template v-for="role in ROLES" :key="role">
                <li v-if="risks[role]" :class="`is-${risks[role]!.level.toLowerCase()}`">
                  <span class="risk__level">{{ risks[role]!.level }}</span>
                  <span>{{ risks[role]!.text }}.</span>
                </li>
              </template>
            </ul>
          </section>
        </section>

        <section class="team__side">
          <!-- the slot in focus -->
          <div class="focus">
            <template v-if="focusCard">
              <div class="focus__card" :class="{ 'is-staged': focusStaged }"><LomCard :card="focusCard" /></div>
              <div class="focus__text">
                <p class="label">{{ selectedRole }}<template v-if="focusStaged"> · preview</template></p>
                <h2 class="focus__name">
                  {{ focusCard.playerName }} <span v-if="focusCard.season" class="focus__year">{{ focusCard.season }}</span>
                </h2>
                <p class="muted focus__meta">
                  {{ focusCard.team || 'Unknown team' }} · level {{ focusLevel }} · {{ depth(focusCard) }} champion{{ depth(focusCard) === 1 ? '' : 's' }} deep
                </p>
                <p v-if="focusPlayer" class="focus__plays tnum">
                  <template v-if="focusPlayer.champion">Plays {{ focusPlayer.champion }} ({{ focusPlayer.mastery }} mastery)</template>
                  <template v-else>No champion in their pool</template>
                  · rated {{ round1(focusPlayer.total) }}
                </p>
                <p v-if="shownChem.byRole[selectedRole]!.bonus" class="focus__chem">
                  +{{ shownChem.byRole[selectedRole]!.bonus }} chemistry · {{ shownChem.byRole[selectedRole]!.reasons.join(' · ') }}
                </p>
                <p v-if="risks[selectedRole]" class="focus__risk">{{ risks[selectedRole]!.text }}.</p>
                <button v-if="!focusStaged && entries[selectedRole]" class="btn btn--quiet" type="button" :disabled="saving" @click="choose(selectedRole, null)">
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
              <div class="seg bench__sort" role="group" aria-label="Sort by">
                <button
                  v-for="s in SORTS" :key="s.id" type="button"
                  :aria-pressed="sortBy === s.id" @click="sortBy = s.id"
                >
                  {{ s.label }}
                </button>
              </div>
            </div>

            <ul v-if="bench.length" class="bench__grid">
              <li v-for="row in bench" :key="row.entry.id">
                <button
                  class="pick"
                  :class="{ 'is-in': row.held, 'is-staged': staged?.entry.id === row.entry.id }"
                  type="button"
                  :disabled="saving"
                  :aria-pressed="staged?.entry.id === row.entry.id"
                  :aria-label="`${row.entry.card.playerName} ${row.entry.card.season ?? ''}, level ${row.entry.level ?? 1}, ${depth(row.entry.card)} deep${row.held ? ', in the five' : `, match rating ${signed(row.swap.matchRating)}`}`"
                  @click="stage(row.entry)"
                >
                  <LomCard :card="row.entry.card" compact :interactive="false" />
                  <span class="pick__line tnum">
                    <span>Lv {{ row.entry.level ?? 1 }} · {{ depth(row.entry.card) }} deep</span>
                    <b v-if="row.held" class="pick__in">In</b>
                    <b v-else class="pick__delta" :class="tone(row.swap.matchRating)">{{ signed(row.swap.matchRating) }}</b>
                  </span>
                  <span v-if="row.swap.bonus" class="pick__chem" :title="`+${row.swap.bonus} ${row.swap.bonusText}`">+{{ row.swap.bonus }} {{ row.swap.bonusText }}</span>
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

          <!-- how the five play -->
          <div class="block strategy">
            <h2 class="label">Strategy</h2>
            <div class="seg" role="group" aria-label="Team strategy">
              <button
                v-for="s in strategies" :key="s.id" type="button"
                :aria-pressed="strategy === s.id" :disabled="savingStrategy"
                @click="setStrategy(s.id)"
              >
                {{ s.name }}
              </button>
            </div>
            <p v-if="currentStrategy" class="strategy__line">
              {{ currentStrategy.idea }} <span class="faint">{{ currentStrategy.effects }}</span>
            </p>
          </div>

          <div class="foot">
            <NuxtLink v-if="filledCount === 5" class="btn btn--ghost" to="/replay">Watch these five play</NuxtLink>
            <button v-else class="btn btn--ghost" type="button" disabled aria-describedby="watch-hint">Watch these five play</button>
            <p id="watch-hint" class="faint">
              <template v-if="filledCount === 5">A sandbox match, played {{ currentStrategy?.name.toLowerCase() }}: nothing is at stake and no result is kept.</template>
              <template v-else>Set {{ missingRoles.join(', ') }} first. Until all five are in, the sandbox can only field a stand-in team.</template>
            </p>
          </div>
        </section>
      </div>

      <!-- a staged swap or the best-five plan, waiting for a yes -->
      <aside v-if="staged && preview" class="tray" aria-live="polite">
        <p class="tray__title">
          {{ staged.entry.card.playerName }} {{ staged.entry.card.season }} at {{ staged.role }}
        </p>
        <p class="tray__deltas tnum">
          <span>Match rating <b :class="tone(preview.delta.matchRating)">{{ signed(preview.delta.matchRating) }}</b></span>
          <span>Chemistry <b :class="tone(preview.delta.chemistry)">{{ signed(preview.delta.chemistry) }}</b></span>
          <span>Pool <b :class="tone(preview.delta.pool)">{{ signed(preview.delta.pool) }}</b></span>
        </p>
        <p v-if="stagedSwap?.completes" class="tray__note">{{ stagedSwap.completes }}</p>
        <div class="tray__actions">
          <button class="btn btn--ghost btn--sm" type="button" @click="cancelPreview">Cancel</button>
          <button class="btn btn--sm" type="button" data-sound="none" :disabled="saving" @click="confirmStage">Confirm</button>
        </div>
      </aside>

      <aside v-else-if="plan" class="tray" aria-live="polite">
        <template v-if="plan.changes.length">
          <p class="tray__title tnum">
            {{ signed(round1(plan.after - plan.before)) }} match rating, {{ plan.changes.length }} change{{ plan.changes.length === 1 ? '' : 's' }}
          </p>
          <ul class="tray__changes">
            <li v-for="role in plan.changes" :key="role">
              <span class="tag">{{ role }}</span>
              <span class="tray__swap">{{ planName(entries[role]) }} → <b>{{ planName(plan.slots[role]) }}</b></span>
            </li>
          </ul>
          <div class="tray__actions">
            <button class="btn btn--ghost btn--sm" type="button" @click="cancelPreview">Cancel</button>
            <button class="btn btn--sm" type="button" data-sound="none" :disabled="saving" @click="applyPlan">Apply</button>
          </div>
        </template>
        <template v-else>
          <p class="tray__title">This is already your best five.</p>
          <p class="tray__note faint">No lineup of cards you own, chemistry included, has a higher match rating.</p>
          <div class="tray__actions">
            <button class="btn btn--ghost btn--sm" type="button" @click="cancelPreview">OK</button>
          </div>
        </template>
      </aside>
    </template>
  </main>
</template>

<style scoped>
.team__skeleton { height: 520px; }
.team .topbar__meta { margin-left: auto; }
.team__auto { flex: none; }
.team__grid { display: grid; gap: 28px; }
.team.has-tray { padding-bottom: 220px; }

.totals { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); margin: 0 0 14px; border-top: 1px solid var(--line-1); border-bottom: 1px solid var(--line-1); }
.totals > div { padding: 12px 0 12px 14px; border-left: 1px solid var(--line-1); }
.totals > div:nth-child(2) { border-left: 0; padding-left: 0; }
.totals > .totals__main { grid-column: 1 / -1; border-left: 0; padding-left: 0; border-bottom: 1px solid var(--line-1); }
.totals dt { font-size: 12px; color: var(--ink-3); }
.totals dd { display: flex; align-items: baseline; gap: 8px; margin: 4px 0 0; }
.totals dd .num { font-size: 28px; }
.totals__main dd .num { font-size: 36px; }
.totals dd .num.is-on { color: var(--gold-1); }
.totals__why { margin: 6px 0 0; font-size: 12px; line-height: 1.4; color: var(--ink-3); }
.ghost { font-size: 14px; font-weight: 760; color: var(--ink-2); }

.is-up { color: var(--gold-1); }
.is-down { color: var(--red-2); }

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
.rift__links line { stroke: var(--gold-2); stroke-width: 1.5; stroke-dasharray: 4 4; opacity: 0.75; vector-effect: non-scaling-stroke; transition: opacity 160ms ease; }
.rift__links line.is-active { stroke-width: 2.5; opacity: 1; }

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
/* A staged card is on the board but not yet yours to keep: dashed, and a touch faded. */
.slot.is-staged :deep(.lom-card) { opacity: 0.82; outline: 2px dashed var(--gold-1); outline-offset: 2px; }
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

/* A core's marker: small to look at, 44px to hit. */
.rift__mark {
  position: absolute;
  z-index: 3;
  translate: -50% -50%;
  min-width: 30px;
  height: 22px;
  padding: 0 6px;
  border: 1px solid rgba(216, 176, 100, 0.6);
  border-radius: 11px;
  background: var(--bg-0);
  color: var(--gold-1);
  font-family: inherit;
  font-size: 11px;
  font-weight: 800;
  cursor: pointer;
}
.rift__mark::before { content: ''; position: absolute; inset: -11px -7px; }
.rift__mark.is-active { background: var(--gold-2); border-color: var(--gold-2); color: var(--gold-ink); }

.rift__wide { position: absolute; top: 8px; right: 8px; z-index: 3; display: grid; gap: 4px; justify-items: end; }
.rift__wideTag {
  min-height: 30px;
  padding: 0 9px;
  border: 1px solid rgba(216, 176, 100, 0.45);
  border-radius: 2px;
  background: rgba(4, 7, 13, 0.85);
  color: var(--ink-1);
  font-family: inherit;
  font-size: 11.5px;
  font-weight: 680;
  cursor: pointer;
}
.rift__wideTag b { color: var(--gold-1); font-weight: 800; }
.rift__wideTag.is-active { border-color: var(--gold-2); background: var(--bg-3); }

.read { margin: 14px 0 0; font-size: 13.5px; color: var(--ink-2); }
.link-reason { color: var(--ink-1); }
.chem { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 6px; }
.chem li { display: flex; gap: 8px; align-items: baseline; font-size: 13.5px; color: var(--ink-2); }
.chem b { color: var(--ink-1); font-weight: 680; }
.chem span { margin-left: auto; color: var(--gold-1); font-weight: 700; font-variant-numeric: tabular-nums; }

.block { margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--line-1); }
.block .label { margin: 0 0 10px; }

.hints { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.hint {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  padding: 8px 12px;
  border: 1px solid var(--line-2);
  border-radius: var(--radius);
  background: var(--bg-2);
  color: var(--ink-1);
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.hint:disabled { cursor: default; color: var(--ink-2); background: transparent; }
.hint__text { flex: 1; min-width: 0; }
.hint__delta { flex: none; font-weight: 800; }
@media (hover: hover) and (pointer: fine) { .hint:hover:not(:disabled) { border-color: var(--line-3); } }

.risks { list-style: none; margin: 0; padding: 0; display: grid; gap: 7px; }
.risks li { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 8px; align-items: baseline; font-size: 13px; color: var(--ink-2); }
.risk__level { font-stretch: 112%; font-size: 10.5px; font-weight: 760; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-3); }
.risks li.is-high .risk__level { color: var(--red-2); }
.risks li.is-medium .risk__level { color: var(--warn-2); }

/* --- focus + bench ---------------------------------------------------------- */
.focus { display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 18px; align-items: center; padding-bottom: 22px; border-bottom: 1px solid var(--line-1); }
.focus__card.is-staged :deep(.lom-card) { outline: 2px dashed var(--gold-1); outline-offset: 3px; }
.focus__name { margin: 4px 0 0; font-size: 26px; line-height: 1; }
.focus__year { color: var(--gold-1); }
.focus__meta { margin: 6px 0 0; font-size: 13px; }
.focus__plays { margin: 6px 0 0; font-size: 13px; color: var(--ink-1); }
.focus__chem { margin: 6px 0 0; font-size: 13px; color: var(--gold-1); }
.focus__risk { margin: 6px 0 0; font-size: 12.5px; color: var(--ink-3); }
.focus__text .btn { margin-top: 12px; }
.focus__empty { grid-column: 1 / -1; margin: 0; padding: 22px 0 0; }

.bench { margin-top: 22px; }
.bench__head { display: grid; gap: 10px; margin-bottom: 14px; }
.bench__head h2 { font-stretch: 92%; font-weight: 720; font-size: 17px; }
.bench__search { min-height: 44px; font-size: 15px; }
.bench__sort button { min-height: 40px; padding: 0 6px; font-size: 10.5px; }
.bench__grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 18px 10px; }
.pick { position: relative; display: block; width: 100%; padding: 0; border: 0; background: none; color: inherit; font-family: inherit; text-align: left; cursor: pointer; }
.pick:disabled { cursor: default; }
.pick.is-in :deep(.lom-card) { box-shadow: 0 0 0 2px var(--gold-2); }
.pick.is-staged :deep(.lom-card) { outline: 2px dashed var(--gold-1); outline-offset: 2px; }
.pick__line { display: flex; align-items: baseline; gap: 4px; margin-top: 6px; font-size: 11px; font-weight: 620; color: var(--ink-3); white-space: nowrap; }
.pick__line > span { overflow: hidden; text-overflow: ellipsis; }
.pick__delta, .pick__in { margin-left: auto; font-weight: 800; }
.pick__in { color: var(--gold-1); font-stretch: 112%; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; }
.pick__chem {
  display: -webkit-box;
  margin-top: 2px;
  overflow: hidden;
  font-size: 11px;
  line-height: 1.3;
  color: var(--gold-1);
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.bench__none { font-size: 14px; }

.strategy .seg button { min-height: 44px; }
.strategy__line { margin: 10px 0 0; font-size: 13px; line-height: 1.45; color: var(--ink-2); }

.foot { display: grid; gap: 8px; justify-items: start; margin-top: 22px; padding-top: 20px; border-top: 1px solid var(--line-1); }
.foot p { margin: 0; font-size: 12.5px; }

/* --- the tray: a preview waiting for Confirm -------------------------------- */
.tray {
  position: fixed;
  left: max(16px, env(safe-area-inset-left, 0px));
  right: max(16px, env(safe-area-inset-right, 0px));
  bottom: calc(var(--nav-h) + env(safe-area-inset-bottom, 0px) + 10px);
  z-index: 31;
  max-width: 560px;
  margin: 0 auto;
  padding: 14px 16px;
  border: 1px solid var(--line-3);
  border-radius: var(--radius);
  background: rgba(12, 18, 30, 0.97);
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}
.tray__title { margin: 0; font-size: 15px; font-weight: 720; color: var(--ink-1); }
.tray__deltas { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 6px 0 0; font-size: 13px; color: var(--ink-2); }
.tray__deltas b { font-weight: 800; }
.tray__note { margin: 6px 0 0; font-size: 12.5px; color: var(--gold-1); }
.tray__note.faint { color: var(--ink-3); }
.tray__changes { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 5px; }
.tray__changes li { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 13px; color: var(--ink-2); }
.tray__changes .tag { flex: none; width: 46px; justify-content: center; }
.tray__swap { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tray__swap b { color: var(--ink-1); font-weight: 700; }
.tray__actions { display: flex; gap: 8px; margin-top: 12px; }
.tray__actions .btn { flex: 1; min-height: 44px; }

@media (min-width: 600px) {
  .totals { grid-template-columns: minmax(0, 1.3fr) repeat(2, minmax(0, 1fr)); }
  .totals > .totals__main { grid-column: auto; border-bottom: 0; }
  .totals > div:nth-child(2) { border-left: 1px solid var(--line-1); padding-left: 14px; }
}

@media (min-width: 1024px) {
  .team__grid { grid-template-columns: minmax(0, 560px) minmax(0, 1fr); gap: 40px; align-items: start; }
  .focus { grid-template-columns: 180px minmax(0, 1fr); }
  .bench__head { grid-template-columns: minmax(0, 1fr) 240px; align-items: center; }
  .bench__sort { grid-column: 1 / -1; justify-self: start; }
  .tray { bottom: 24px; }
}

@media (prefers-reduced-motion: reduce) {
  .slot, .slot :deep(.lom-card), .rift__links line { transition: none; }
}
</style>
