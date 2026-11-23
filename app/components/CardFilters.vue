<script setup lang="ts">
import { SORTS, activeFilterCount } from '@lom/card-engine';

/**
 * Search, sort and filters for a list of cards: yours, a friend's, or the catalogue's sets.
 *
 * What is always on screen is what gets used every visit — the search field, the sort and
 * the rarity strip, which doubles as the completion count. Everything else (role, league,
 * season, team, starred) sits in one sheet behind a Filters button that says how many are
 * on, and each active filter shows as a chip that removes itself, so nothing is ever
 * filtered out of sight.
 *
 * The state is the parent's — it lives in the URL — and this only proposes changes.
 */
const props = withDefaults(defineProps<{
  modelValue: Record<string, any>;
  options: { leagues: string[]; years: string[]; teams: string[] };
  /** Per rarity: how many are owned, and how many exist (null until the catalogue loads). */
  bands?: Record<string, { owned: number; total: number | null }>;
  resultCount: number;
  /** Controls not to offer, e.g. role and rarity in the sets view. */
  hide?: string[];
  showFav?: boolean;
  placeholder?: string;
}>(), { bands: () => ({}), hide: () => [], showFav: false, placeholder: 'Player, team, season or champion' });

const emit = defineEmits<{ 'update:modelValue': [Record<string, any>] }>();

const ROLES = ['TOP', 'JNG', 'MID', 'BOT', 'SUP'];
const BANDS_DESC = ['ICON', 'LEGENDARY', 'EPIC', 'RARE', 'COMMON'];
const BAND_LABEL: Record<string, string> = { COMMON: 'Common', RARE: 'Rare', EPIC: 'Epic', LEGENDARY: 'Legendary', ICON: 'Icon' };

const shows = (k: string) => !props.hide.includes(k);
const set = (patch: Record<string, any>) => emit('update:modelValue', { ...props.modelValue, ...patch });
const toggle = (k: string, v: string) => set({ [k]: props.modelValue[k] === v ? null : v });

// Search: typed locally, sent on a short pause, so the URL is not rewritten per keystroke.
const q = ref(String(props.modelValue.q || ''));
watch(() => props.modelValue.q, (v) => { if ((v || '') !== q.value) q.value = String(v || ''); });
let timer: ReturnType<typeof setTimeout> | undefined;
function onSearch(e: Event) {
  q.value = (e.target as HTMLInputElement).value;
  clearTimeout(timer);
  timer = setTimeout(() => set({ q: q.value }), 160);
}
onBeforeUnmount(() => clearTimeout(timer));

const onSort = (e: Event) => set({ sort: (e.target as HTMLSelectElement).value });
const onTeam = (e: Event) => set({ team: (e.target as HTMLSelectElement).value || null });

const count = computed(() => activeFilterCount(Object.fromEntries(
  Object.entries(props.modelValue).filter(([k]) => shows(k)),
)));

/** One chip per active filter, each removing only itself. */
const chips = computed(() => {
  const s = props.modelValue;
  const out: { k: string; label: string }[] = [];
  if (s.role && shows('role')) out.push({ k: 'role', label: s.role });
  if (s.rarity && shows('rarity')) out.push({ k: 'rarity', label: BAND_LABEL[s.rarity] || s.rarity });
  if (s.league && shows('league')) out.push({ k: 'league', label: s.league });
  if (s.year && shows('year')) out.push({ k: 'year', label: s.year });
  if (s.team && shows('team')) out.push({ k: 'team', label: s.team });
  if (s.fav && shows('fav')) out.push({ k: 'fav', label: 'Starred' });
  return out;
});

function clearAll() {
  q.value = '';
  set({ q: '', role: null, rarity: null, league: null, year: null, team: null, fav: null });
}

const open = ref(false);
const sheet = ref<HTMLElement | null>(null);
watch(open, async (now) => {
  if (!now) return;
  await nextTick();
  sheet.value?.querySelector<HTMLElement>('button, select')?.focus();
});
function onKey(e: KeyboardEvent) { if (e.key === 'Escape') open.value = false; }
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

const bandText = (b: string) => {
  const n = props.bands[b];
  if (!n) return '0';
  return n.total == null ? String(n.owned) : `${n.owned}/${n.total}`;
};
</script>

<template>
  <div class="cf">
    <div class="cf__bar">
      <input
        :value="q" class="input cf__search" type="search" enterkeyhint="search"
        :placeholder="placeholder" aria-label="Search cards" @input="onSearch"
      >
      <div class="cf__row">
        <button class="chip cf__open" type="button" aria-haspopup="dialog" :aria-expanded="open" @click="open = true">
          <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" /></svg>
          Filters<span v-if="count" class="chip__n">{{ count }}</span>
        </button>
        <label class="cf__sort">
          <span class="faint">Sort</span>
          <select :value="modelValue.sort" aria-label="Sort cards" @change="onSort">
            <option v-for="s in SORTS" :key="s.id" :value="s.id">{{ s.label }}</option>
          </select>
        </label>
        <slot name="actions" />
      </div>
    </div>

    <div v-if="chips.length" class="cf__active">
      <button v-for="c in chips" :key="c.k" class="chip" type="button" :aria-label="`Remove filter ${c.label}`" @click="set({ [c.k]: null })">
        {{ c.label }}<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" /></svg>
      </button>
      <button class="cf__clear" type="button" @click="clearAll">Clear all</button>
    </div>

    <div v-if="shows('rarity')" class="cf__bands" role="group" aria-label="Rarity">
      <button
        v-for="b in BANDS_DESC" :key="b" class="chip" type="button"
        :aria-pressed="modelValue.rarity === b" :disabled="!bands[b]?.owned && modelValue.rarity !== b"
        @click="toggle('rarity', b)"
      >
        <i class="gem" :class="`gem--${b.toLowerCase()}`" aria-hidden="true" />
        {{ BAND_LABEL[b] }}<span class="chip__n tnum">{{ bandText(b) }}</span>
      </button>
    </div>

    <Teleport to="body">
      <div v-if="open" class="cf-backdrop" @click="open = false" />
      <aside v-if="open" ref="sheet" class="cf-sheet" role="dialog" aria-modal="true" aria-label="Filters">
        <header class="cf-sheet__head">
          <h2>Filters</h2>
          <button class="btn btn--quiet" type="button" @click="open = false">Done</button>
        </header>

        <section v-if="shows('role')" class="cf-sheet__sect">
          <h3 class="eyebrow">Role</h3>
          <div class="seg" role="group" aria-label="Role">
            <button type="button" :aria-pressed="!modelValue.role" @click="set({ role: null })">All</button>
            <button v-for="r in ROLES" :key="r" type="button" :aria-pressed="modelValue.role === r" @click="toggle('role', r)">{{ r }}</button>
          </div>
        </section>

        <section v-if="shows('league') && options.leagues.length" class="cf-sheet__sect">
          <h3 class="eyebrow">League</h3>
          <div class="chips">
            <button v-for="l in options.leagues" :key="l" class="chip" type="button" :aria-pressed="modelValue.league === l" @click="toggle('league', l)">{{ l }}</button>
          </div>
        </section>

        <section v-if="shows('year') && options.years.length" class="cf-sheet__sect">
          <h3 class="eyebrow">Season</h3>
          <div class="chips">
            <button v-for="y in options.years" :key="y" class="chip tnum" type="button" :aria-pressed="modelValue.year === y" @click="toggle('year', y)">{{ y }}</button>
          </div>
        </section>

        <section v-if="shows('team') && options.teams.length" class="cf-sheet__sect">
          <h3 class="eyebrow"><label for="cf-team">Team</label></h3>
          <select id="cf-team" class="input" :value="modelValue.team || ''" @change="onTeam">
            <option value="">Any team</option>
            <option v-for="t in options.teams" :key="t" :value="t">{{ t }}</option>
          </select>
        </section>

        <section v-if="showFav && shows('fav')" class="cf-sheet__sect">
          <h3 class="eyebrow">Showcase</h3>
          <button class="chip" type="button" :aria-pressed="!!modelValue.fav" @click="set({ fav: modelValue.fav ? null : '1' })">★ Starred only</button>
        </section>

        <footer class="cf-sheet__foot">
          <button class="btn btn--quiet" type="button" @click="clearAll">Clear all</button>
          <button class="btn btn--ghost" type="button" @click="open = false">
            Show {{ resultCount }}
          </button>
        </footer>
      </aside>
    </Teleport>
  </div>
</template>

<style scoped>
.cf { display: grid; gap: 10px; margin-bottom: 14px; }
.cf__bar { display: grid; gap: 8px; }
.cf__search { min-height: 44px; }
.cf__row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cf__open svg { width: 17px; height: 17px; }
.cf__sort {
  display: inline-flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 4px 0 12px;
  border: 1px solid var(--line-2); border-radius: 2px; font-size: 12.5px; font-weight: 620;
}
.cf__sort select {
  appearance: none; min-height: 34px; padding: 0 22px 0 2px; border: 0; background: transparent; color: var(--ink-1);
  font: inherit; font-weight: 700; cursor: pointer;
  background-image: linear-gradient(45deg, transparent 50%, var(--ink-3) 50%), linear-gradient(135deg, var(--ink-3) 50%, transparent 50%);
  background-position: calc(100% - 11px) 55%, calc(100% - 6px) 55%;
  background-size: 5px 5px; background-repeat: no-repeat;
}
.cf__sort select option { background: var(--bg-2); color: var(--ink-1); }
@media (pointer: coarse) { .cf__sort, .cf__sort select { min-height: 44px; } }

.cf__active { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.cf__active .chip svg { width: 14px; height: 14px; margin-right: -4px; }
.cf__clear { appearance: none; min-height: 36px; padding: 0 8px; border: 0; background: none; color: var(--ink-3); font: inherit; font-size: 12.5px; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
@media (pointer: coarse) { .cf__clear { min-height: 44px; } }

.cf__bands { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; margin-right: -16px; padding-right: 16px; }
.cf__bands::-webkit-scrollbar { display: none; }

.cf-backdrop { position: fixed; inset: 0; z-index: 55; background: rgba(2, 4, 8, 0.6); }
.cf-sheet {
  position: fixed; z-index: 56; left: 0; right: 0; bottom: 0;
  max-height: 86vh; max-height: 86dvh; overflow-y: auto; overscroll-behavior: contain;
  display: grid; gap: 18px;
  padding: 14px 16px calc(18px + env(safe-area-inset-bottom, 0px));
  background: var(--bg-1); border-top: 1px solid var(--line-2); border-radius: 6px 6px 0 0;
}
@media (min-width: 760px) {
  .cf-sheet { left: auto; top: 0; width: 380px; max-height: none; border-top: 0; border-left: 1px solid var(--line-2); border-radius: 0; align-content: start; }
}
.cf-sheet__head { display: flex; align-items: center; justify-content: space-between; }
.cf-sheet__head h2 { font-stretch: 92%; font-weight: 760; font-size: 20px; }
.cf-sheet__sect { display: grid; gap: 8px; }
.cf-sheet__sect h3 { margin: 0; }
.cf-sheet__foot { display: flex; justify-content: space-between; gap: 8px; position: sticky; bottom: calc(-18px - env(safe-area-inset-bottom, 0px)); padding: 10px 0 0; background: var(--bg-1); }
</style>
