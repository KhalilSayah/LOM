<script setup lang="ts">
import { squareUrl, championName } from '@lom/card-engine';
import { toCard } from '~~/shared/cardShape';

/**
 * One card, large: the face you can tilt and turn, and everything the face is too small
 * to say — the six numbers on a radar, the season line, the whole champion pool, the
 * card's level, whether it is in your five, and what its duplicates turned into.
 *
 * Two modes. Yours (/card/<key>) reads your own collection and can act on the card: put
 * it in your five, star it into your showcase, pin it to compare. A friend's
 * (/card/<key>?from=<share code>) reads through /api/discovery/card, which the code
 * authorises, and only looks: the one thing you can do with somebody else's card is
 * compare yours against it.
 */

const route = useRoute();
const router = useRouter();
const supabase = useSupabaseClient();
const managerId = useManagerId();
const { isPinned, toggle: togglePin } = useCompare();

const key = computed(() => String(route.params.key || ''));
const fromCode = computed(() => (route.query.from ? String(route.query.from) : null));

const held = ref<any>(null);
const owner = ref<any>(null);
const loading = ref(true);
const missing = ref(false);
const loadError = ref('');

/** Roster state for this card's role: the card in that slot, if any. */
const slot = ref<{ role: string; id: string; name: string } | null>(null);
const favourite = ref(false);
const starsReady = ref(true);

const SELECT = `
  id, level, xp, copies, acquired_at,
  card:card_definitions!inner (
    card_key, catalogue_version_id, player_name, season, team, region, role, ovr, rarity,
    sub_stats, accolades, season_summary, provenance, art_champion_key, art_focus,
    pool:card_champion_pool ( champion_key, champion_name, games, winrate, mastery, slot )
  )
`;

const ACCOLADES: Record<string, string> = {
  WORLDS_WINNER: 'World champion',
  INTERNATIONAL_FINALIST: 'International finalist',
  FINALS_MVP: 'Finals MVP',
  SEASON_MVP: 'Season MVP',
  DOMESTIC_TITLE: 'Domestic title',
};

/**
 * What a repeat pull pays, per server/utils/roll.ts (DUPLICATE_XP, DUPLICATE_CREDITS).
 * Copied rather than imported because app code may not import server code; if those
 * change, change these.
 */
const DUPLICATE_XP = 250;
const DUPLICATE_CREDITS: Record<string, number> = { COMMON: 15, RARE: 30, EPIC: 60, LEGENDARY: 150, ICON: 400 };
const XP_PER_LEVEL = 400;
const MAX_LEVEL = 10;

const message = (e: any, fallback: string) =>
  e?.statusMessage || e?.data?.statusMessage || e?.data?.message || e?.message || fallback;

async function loadMine() {
  if (!managerId.value) return;
  const [{ data, error }, { data: active }] = await Promise.all([
    supabase
      .from('collection_cards')
      .select(SELECT)
      .eq('profile_id', managerId.value)
      .eq('card.card_key', key.value)
      .order('acquired_at', { ascending: false })
      .limit(10),
    supabase.from('catalogue_versions').select('id').eq('is_active', true).maybeSingle(),
  ]);
  if (error) throw error;

  // One key can name two printings when a card was kept across a catalogue change. The
  // printing in the active catalogue is the one the game plays; after that, the newest.
  const list = (data || []).filter((r: any) => r.card);
  const row: any = list.find((r: any) => r.card.catalogue_version_id === (active as any)?.id) || list[0];
  if (!row) { missing.value = true; return; }
  held.value = { ...row, card: toCard(row.card) };
  await Promise.all([loadSlot(), loadStar()]);
}

async function loadSlot() {
  if (!held.value || !managerId.value) return;
  const role = held.value.card.role;
  const { data, error } = await supabase
    .from('roster_slots')
    .select('role, collection_card_id, held:collection_cards ( card:card_definitions ( player_name, season ) )')
    .eq('profile_id', managerId.value)
    .eq('role', role)
    .maybeSingle();
  if (error || !data) { slot.value = null; return; }
  const c = (data as any).held?.card;
  slot.value = {
    role,
    id: (data as any).collection_card_id,
    name: c ? `${c.player_name}${c.season ? ` ${c.season}` : ''}` : 'another card',
  };
}

async function loadStar() {
  if (!held.value) return;
  const { data, error } = await supabase
    .from('collection_cards').select('is_favourite').eq('id', held.value.id).maybeSingle();
  // Before migration 0017 the column does not exist: no stars, and no star button.
  starsReady.value = !error;
  favourite.value = !error && !!(data as any)?.is_favourite;
}

async function loadFriend() {
  const res = await $fetch<any>('/api/discovery/card', { query: { code: fromCode.value, key: key.value } });
  owner.value = res.manager;
  held.value = { ...res.held, acquired_at: res.held.acquiredAt };
}

async function load() {
  loading.value = true;
  missing.value = false;
  loadError.value = '';
  try {
    if (fromCode.value) await loadFriend();
    else await loadMine();
  } catch (e: any) {
    // A friend's card that is not there is a 404 with a sentence; anything else is a
    // failure to read, which must not be dressed up as "you do not have this card".
    if (fromCode.value && (e?.statusCode === 404 || e?.status === 404)) missing.value = true;
    else loadError.value = message(e, 'Could not load this card.');
  } finally {
    loading.value = false;
  }
}

watch([managerId, key, fromCode], () => {
  if (fromCode.value || managerId.value) load();
}, { immediate: true });

// --- readouts ---------------------------------------------------------------

const STATS: Array<[string, string]> = [
  ['laning', 'Lane'], ['teamfight', 'Teamfight'], ['mechanics', 'Mechanics'],
  ['macro', 'Macro'], ['vision', 'Vision'], ['consistency', 'Consistency'],
];
/** Ratings run 40-99; the radar and the bars stretch that range across the full length. */
const share = (v: number) => Math.max(0, Math.min(1, (v - 40) / 59));

/** The hexagon: six axes from the top, clockwise. */
const radar = computed(() => {
  const s = held.value?.card?.subStats || {};
  const pt = (i: number, r: number) => {
    const a = (-90 + i * 60) * (Math.PI / 180);
    return `${(80 + Math.cos(a) * r).toFixed(1)},${(80 + Math.sin(a) * r).toFixed(1)}`;
  };
  return {
    outer: STATS.map((_, i) => pt(i, 64)).join(' '),
    inner: STATS.map((_, i) => pt(i, 32)).join(' '),
    shape: STATS.map(([k], i) => pt(i, 64 * share(Number(s[k] ?? 40)))).join(' '),
    axes: STATS.map((_, i) => pt(i, 64)),
  };
});

const pool = computed(() => (held.value?.card?.championPool || []).map((p: any) => ({
  ...p, champion: championName(p.champion || p.key),
})));
const deep = computed(() => pool.value.filter((p: any) => p.mastery >= 70));
const shallow = computed(() => pool.value.filter((p: any) => p.mastery < 70));

const isMax = computed(() => (held.value?.level ?? 1) >= MAX_LEVEL);
const xpShare = computed(() => (isMax.value ? 100 : Math.min(100, ((held.value?.xp ?? 0) / XP_PER_LEVEL) * 100)));

const repeats = computed(() => Math.max(0, (held.value?.copies ?? 1) - 1));
const repeatCredits = computed(() => DUPLICATE_CREDITS[held.value?.card?.rarity] ?? 0);

/** A failed champion square shows the initial instead of a broken image. */
function iconFailed(e: Event) {
  const img = e.target as HTMLImageElement;
  img.style.visibility = 'hidden';
  img.parentElement?.classList.add('is-letter');
}

// --- actions (yours only) ---------------------------------------------------

const inFive = computed(() => !!held.value && slot.value?.id === held.value.id);
const replacing = ref(false);
const placing = ref(false);
const actionNote = ref('');
const actionError = ref('');

function askPlace() {
  actionNote.value = '';
  actionError.value = '';
  if (slot.value && slot.value.id !== held.value.id) replacing.value = true;
  else place();
}

async function place() {
  if (placing.value || !held.value) return;
  placing.value = true;
  actionError.value = '';
  try {
    const role = held.value.card.role;
    await $fetch('/api/roster/slot', { method: 'POST', body: { role, collectionCardId: held.value.id } });
    const was = replacing.value ? slot.value?.name : null;
    replacing.value = false;
    await loadSlot();
    playSound('slotIn');
    actionNote.value = was
      ? `In your five at ${role}, in place of ${was}.`
      : `In your five at ${role}.`;
  } catch (e: any) {
    actionError.value = message(e, 'Could not put this card in your five.');
  } finally {
    placing.value = false;
  }
}

const starring = ref(false);
async function toggleStar() {
  if (starring.value || !held.value) return;
  starring.value = true;
  actionError.value = '';
  const next = !favourite.value;
  try {
    await $fetch('/api/discovery/showcase', { method: 'POST', body: { collectionCardId: held.value.id, on: next } });
    favourite.value = next;
    // The Cards screen keeps its list for the session; keep its stars in step.
    const favs = useState<string[]>('cards:favs', () => []);
    favs.value = next ? [...new Set([...favs.value, held.value.id])] : favs.value.filter((id) => id !== held.value.id);
  } catch (e: any) {
    actionError.value = message(e, 'Could not change the star.');
  } finally {
    starring.value = false;
  }
}

const pinId = computed(() => (held.value ? `${fromCode.value || 'mine'}:${held.value.id}` : ''));
function pin() {
  if (!held.value) return;
  togglePin({
    id: pinId.value,
    owner: owner.value ? owner.value.displayName : null,
    level: held.value.level,
    card: held.value.card,
  });
}

function goBack() {
  if (import.meta.client && window.history.state?.back) router.back();
  else router.push(fromCode.value ? `/m/${fromCode.value}` : '/collection');
}

useHead(() => ({
  title: held.value
    ? `${held.value.card.playerName} ${held.value.card.season} — LOM`
    : 'Card — LOM',
}));
</script>


<template>
  <main class="page page--wide detail">
    <header class="topbar">
      <button class="backlink" type="button" data-sound="back" @click="goBack">
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>Back
      </button>
      <span v-if="held" class="rar" :class="`rar--${held.card.rarity.toLowerCase()}`">
        <i class="gem" :class="`gem--${held.card.rarity.toLowerCase()}`" aria-hidden="true" />{{ held.card.rarity.toLowerCase() }}
      </span>
    </header>

    <p v-if="owner" class="whose">
      From <NuxtLink :to="`/m/${fromCode}`">{{ owner.displayName }}'s collection</NuxtLink> · view only
    </p>

    <div v-if="loading" class="skeleton detail-skeleton" />

    <div v-else-if="loadError" class="empty" role="alert">
      <h2>This card did not load</h2>
      <p>{{ loadError }}</p>
      <button class="btn btn--ghost" type="button" @click="load">Retry</button>
    </div>

    <div v-else-if="missing" class="empty">
      <template v-if="fromCode">
        <h2>Not in their collection</h2>
        <p>{{ owner?.displayName || 'They' }} do not hold this card.</p>
        <NuxtLink class="btn btn--ghost" :to="`/m/${fromCode}`">Back to their cards</NuxtLink>
      </template>
      <template v-else>
        <h2>Not in your collection</h2>
        <p>You do not hold this card yet.</p>
        <NuxtLink class="btn btn--ghost" to="/collection">Back to Cards</NuxtLink>
      </template>
    </div>

    <div v-else-if="held" class="detail__grid">
      <section class="detail__hero">
        <div class="detail__card"><LomCard :card="held.card" /></div>
        <p class="detail__hint">Drag to tilt · tap to turn it over</p>
      </section>

      <section class="detail__info">
        <h1 class="detail__name">{{ held.card.playerName }} <span>{{ held.card.season }}</span></h1>
        <p class="detail__who">{{ held.card.team }} · {{ held.card.region }} · {{ held.card.role }}</p>
        <ul v-if="held.card.accolades?.length || inFive || favourite" class="accolades">
          <li v-if="inFive" class="tag">In your five ({{ held.card.role }})</li>
          <li v-if="favourite" class="tag">★ In your showcase</li>
          <li v-for="a in held.card.accolades" :key="a" class="tag tag--new">{{ ACCOLADES[a] || a }}</li>
        </ul>

        <!-- what you can do with it ---------------------------------------- -->
        <div class="actions">
          <template v-if="!fromCode">
            <template v-if="!inFive && !replacing">
              <button class="btn" type="button" :disabled="placing" data-sound="none" @click="askPlace">
                {{ placing ? 'Putting it in' : 'Put in your five' }}
              </button>
            </template>
            <button
              v-if="starsReady" class="btn btn--quiet" type="button" :aria-pressed="favourite" :disabled="starring"
              data-sound="toggle" @click="toggleStar"
            >{{ favourite ? '★ Starred' : '☆ Star' }}</button>
          </template>
          <button class="btn btn--quiet" type="button" :aria-pressed="isPinned(pinId)" data-sound="toggle" @click="pin">
            {{ isPinned(pinId) ? 'Pinned to compare' : 'Compare' }}
          </button>
        </div>

        <div v-if="replacing && slot" class="notice confirm" role="alertdialog" aria-labelledby="replace-q">
          <p id="replace-q">{{ slot.name }} holds {{ slot.role }} in your five. Put {{ held.card.playerName }} {{ held.card.season }} there instead?</p>
          <div class="confirm__row">
            <button class="btn btn--sm" type="button" :disabled="placing" data-sound="none" @click="place">{{ placing ? 'Replacing' : 'Replace' }}</button>
            <button class="btn btn--quiet" type="button" data-sound="back" @click="replacing = false">Keep {{ slot.name }}</button>
          </div>
        </div>
        <p v-if="actionNote" class="notice notice--live" role="status">
          {{ actionNote }} <NuxtLink to="/roster">See your five</NuxtLink>
        </p>
        <p v-if="actionError" class="notice notice--bad" role="alert">{{ actionError }}</p>
        <p v-if="!fromCode && starsReady && !favourite" class="hint faint">Starred cards, up to three, are what friends see first on your page.</p>

        <dl class="facts">
          <div><dt>Overall</dt><dd class="num">{{ held.card.ovr }}</dd></div>
          <div>
            <dt>Level {{ held.level }}<template v-if="isMax"> · max</template></dt>
            <dd v-if="isMax" class="num">Max</dd>
            <dd v-else class="num">{{ held.xp }}<small>/{{ XP_PER_LEVEL }} XP</small></dd>
            <div class="meter" :class="{ 'is-max': isMax }"><i :style="{ width: `${xpShare}%` }" /></div>
          </div>
          <div><dt>Pulled</dt><dd class="num">{{ held.copies }}<small>{{ held.copies === 1 ? 'time' : 'times' }}</small></dd></div>
        </dl>

        <p class="dupes">
          <template v-if="repeats > 0">
            {{ fromCode ? 'They' : 'You' }} pulled this card {{ held.copies }} times and keep one. Each repeat was turned into
            {{ DUPLICATE_XP }} XP for this card<template v-if="repeatCredits"> and {{ repeatCredits }} Credits</template>
            — {{ repeats }} {{ repeats === 1 ? 'repeat' : 'repeats' }} so far. Repeats are not kept as copies; there is nothing to trade or spend.
          </template>
          <template v-else>
            Pull this card again and the repeat becomes {{ DUPLICATE_XP }} XP for it<template v-if="repeatCredits"> and {{ repeatCredits }} Credits</template>. Repeats are not kept as copies.
          </template>
        </p>

        <section class="block">
          <h2 class="sect">Season {{ held.card.season }}<span class="faint">rated against every {{ held.card.role.toLowerCase() }} that year</span></h2>
          <div class="stats">
            <svg viewBox="0 0 160 160" class="radar" role="img" :aria-label="`Sub-stats: ${STATS.map(([k, l]) => `${l} ${held.card.subStats?.[k]}`).join(', ')}`">
              <polygon :points="radar.outer" fill="none" stroke="rgba(200,215,255,.16)" />
              <polygon :points="radar.inner" fill="none" stroke="rgba(200,215,255,.1)" />
              <line v-for="(a, i) in radar.axes" :key="i" x1="80" y1="80" :x2="a.split(',')[0]" :y2="a.split(',')[1]" stroke="rgba(200,215,255,.07)" />
              <polygon :points="radar.shape" fill="rgba(216,176,100,.16)" stroke="#d8b064" stroke-width="1.5" />
            </svg>
            <ul class="bars">
              <li v-for="[k, label] in STATS" :key="k">
                <span>{{ label }}</span>
                <span class="meter"><i :style="{ width: `${share(held.card.subStats?.[k] ?? 40) * 100}%` }" /></span>
                <b class="tnum">{{ held.card.subStats?.[k] ?? '—' }}</b>
              </li>
            </ul>
          </div>
          <dl v-if="Object.keys(held.card.seasonSummary || {}).length" class="season">
            <div v-for="(value, label) in held.card.seasonSummary" :key="label">
              <dt>{{ label }}</dt>
              <dd class="tnum">{{ value }}</dd>
            </div>
          </dl>
        </section>

        <section class="block">
          <h2 class="sect">Champion pool<span class="faint">mastery · games</span></h2>
          <ul class="pool">
            <li v-for="p in deep" :key="p.key">
              <span class="pool__sq" :data-letter="p.champion.slice(0, 1)"><img :src="squareUrl(p.key) || ''" alt="" width="34" height="34" loading="lazy" @error="iconFailed"></span>
              <span class="pool__name">{{ p.champion }}<small>{{ p.games }} games<template v-if="p.winrate"> · {{ Math.round(Number(p.winrate) * 100) }}% wins</template></small></span>
              <span class="meter"><i :style="{ width: `${p.mastery}%` }" /></span>
              <b class="tnum">{{ p.mastery }}</b>
            </li>
          </ul>
          <template v-if="shallow.length">
            <p class="cutline">Below 70 · a penalty in the draft</p>
            <ul class="pool pool--low">
              <li v-for="p in shallow" :key="p.key">
                <span class="pool__sq" :data-letter="p.champion.slice(0, 1)"><img :src="squareUrl(p.key) || ''" alt="" width="34" height="34" loading="lazy" @error="iconFailed"></span>
                <span class="pool__name">{{ p.champion }}<small>{{ p.games }} games</small></span>
                <span class="meter"><i :style="{ width: `${p.mastery}%` }" /></span>
                <b class="tnum">{{ p.mastery }}</b>
              </li>
            </ul>
          </template>
        </section>

        <p class="detail__prov">{{ typeof held.card.provenance === 'string' ? held.card.provenance : '' }}</p>
      </section>
    </div>

    <CompareTray />
  </main>
</template>

<style scoped>
.backlink { display: inline-flex; align-items: center; gap: 4px; min-height: 44px; margin-left: -6px; padding: 0 8px 0 0; border: 0; background: none; color: var(--ink-2); font-size: 13.5px; font-weight: 600; cursor: pointer; }
.backlink svg { width: 20px; height: 20px; }
.backlink:hover { color: var(--ink-1); }
.rar { display: inline-flex; align-items: center; gap: 7px; font-stretch: 114%; font-size: 11px; font-weight: 760; letter-spacing: 0.14em; text-transform: uppercase; }
.rar--common { color: var(--r-common); } .rar--rare { color: var(--r-rare); } .rar--epic { color: var(--r-epic); }
.rar--legendary { color: var(--r-legendary); } .rar--icon { color: var(--r-icon); }

.whose { margin: -6px 0 14px; font-size: 13.5px; color: var(--ink-2); }

.detail-skeleton { aspect-ratio: 63 / 88; max-width: 320px; margin: 0 auto; }
.detail__grid { display: grid; gap: 24px; }
.detail__hero { display: grid; justify-items: center; gap: 10px; }
.detail__card { width: min(100%, 300px); }
.detail__hint { margin: 0; font-size: 12px; color: var(--ink-3); }

.detail__name { font-size: clamp(32px, 8vw, 48px); line-height: 0.92; }
.detail__name span { color: var(--gold-1); }
.detail__who { margin: 6px 0 0; font-size: 13.5px; color: var(--ink-2); }
.accolades { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }

.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.confirm { margin: 12px 0 0; }
.confirm p { margin: 0; }
.confirm__row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.actions + .notice, .confirm + .notice { margin-top: 12px; }
.hint { margin-top: 10px; }

.facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 20px 0 0; border-top: 1px solid var(--line-1); border-bottom: 1px solid var(--line-1); }
.facts > div { padding: 12px 0 12px 14px; border-left: 1px solid var(--line-1); }
.facts > div:first-child { padding-left: 0; border-left: 0; }
.facts dt { font-size: 12px; color: var(--ink-3); }
.facts dd { margin: 4px 0 0; font-size: 26px; }
.facts dd small { font-stretch: 100%; font-weight: 500; font-size: 12px; color: var(--ink-3); margin-left: 4px; }
.facts .meter { margin: 8px 12px 0 0; height: 3px; }
.facts .meter.is-max i { background: var(--gold-2); }

.dupes { margin: 12px 0 0; font-size: 13px; line-height: 1.55; color: var(--ink-2); }

.sect { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin: 0 0 14px; font-stretch: 92%; font-weight: 720; font-size: 17px; }
.sect .faint { font-stretch: 100%; font-weight: 500; font-size: 12.5px; }

.stats { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 18px; align-items: center; }
.radar { width: 150px; height: 150px; }
.bars { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.bars li { display: grid; grid-template-columns: 88px minmax(0, 1fr) 26px; gap: 10px; align-items: center; font-size: 12.5px; color: var(--ink-2); }
.bars .meter { height: 3px; }
.bars .meter i { background: var(--ink-2); }
.bars b { text-align: right; color: var(--ink-1); }
@media (max-width: 420px) {
  .stats { grid-template-columns: 1fr; justify-items: center; }
  .bars { width: 100%; }
}

.season { display: grid; grid-template-columns: repeat(auto-fit, minmax(80px, 1fr)); gap: 10px; margin: 18px 0 0; }
.season dt { font-size: 12px; color: var(--ink-3); }
.season dd { margin: 2px 0 0; font-stretch: 80%; font-weight: 800; font-size: 20px; }

.pool { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.pool li { display: grid; grid-template-columns: 34px minmax(0, 1fr) 72px 28px; gap: 12px; align-items: center; padding: 6px 0; }
.pool__sq { position: relative; display: block; width: 34px; height: 34px; border-radius: 3px; overflow: hidden; background: var(--bg-3); }
.pool__sq img { display: block; }
.pool__sq.is-letter::after { content: attr(data-letter); position: absolute; inset: 0; display: grid; place-items: center; font-weight: 760; color: var(--ink-2); }
.pool__name { min-width: 0; font-size: 14px; font-weight: 620; }
.pool__name small { display: block; font-size: 11.5px; font-weight: 500; color: var(--ink-3); }
.pool b { text-align: right; font-weight: 760; }
.pool--low { opacity: 0.55; }
.pool--low .meter i { background: var(--ink-3); }
.cutline { display: flex; align-items: center; gap: 10px; margin: 8px 0; font-size: 11.5px; color: var(--ink-3); }
.cutline::after { content: ''; flex: 1; height: 1px; background: var(--line-1); }

.detail__prov { margin: 24px 0 0; font-size: 12px; line-height: 1.6; color: var(--ink-3); }

@media (min-width: 900px) {
  .detail__grid { grid-template-columns: 340px minmax(0, 1fr); gap: 48px; align-items: start; }
  .detail__hero { position: sticky; top: calc(var(--appbar-h) + 20px); }
  .detail__card { width: 100%; }
}
</style>
