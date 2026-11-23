<script setup lang="ts">
/**
 * A leaguemate, as an opponent sees them: their season, not their cards.
 *
 * This screen used to show their whole collection and the exact five they field. docs/01
 * section 4 says the full collection is never visible to an opponent, and docs/05 section
 * 2 reveals the starting five at draft start — knowing it the evening before is the whole
 * of banning. So it shows what sharing a league does earn you: where they sit, how they
 * are playing, how they do against you, and their last three results.
 *
 * On your own page the same numbers, plus the way to your roster.
 */
import { dateLabel, ymdIn } from '~~/shared/league';

const route = useRoute();
const leagueId = computed(() => String(route.params.id || ''));
const memberId = computed(() => String(route.params.memberId || ''));

const data = ref<any>(null);
const loading = ref(true);
const error = ref('');
const note = ref('');

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

const member = computed<any>(() => data.value?.member ?? null);
const record = computed<any>(() => data.value?.record ?? null);
const h2h = computed<any>(() => data.value?.headToHead ?? null);
const recent = computed<any[]>(() => data.value?.recent ?? []);
const form = computed<string[]>(() => data.value?.form ?? []);

const ordinal = (n: number) => {
  const t = n % 100;
  if (t >= 11 && t <= 13) return n + 'th';
  return n + (n % 10 < 4 ? ['th', 'st', 'nd', 'rd'][n % 10] : 'th');
};

const clock = (seconds: number | null) => {
  if (!seconds) return '';
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

const when = (iso: string | null) => (iso ? dateLabel(ymdIn(iso)) : '');

const STAGE: Record<string, string> = { SEMI: 'Semi-final', GRAND_FINAL: 'Final' };

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
  title: member.value ? `${member.value.teamName} — LOM` : 'Team — LOM',
}));
</script>

<template>
  <main class="page">
    <header class="topbar">
      <NuxtLink class="backlink" :to="`/leagues/${leagueId}`"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>{{ data?.league?.name || 'League' }}</NuxtLink>
      <span v-if="data" class="topbar__meta tnum">Season {{ data.league.season }}</span>
    </header>

    <p v-if="error" class="notice notice--bad" role="alert">{{ error }}</p>
    <p v-if="note" class="notice" role="status">{{ note }}</p>

    <div v-if="loading" class="skeleton head-skeleton" />

    <template v-else-if="data">
      <section class="who">
        <h1 class="who__name">
          {{ member.teamName }}
          <span v-if="member.isOwner" class="tag">host</span>
          <span v-if="member.isMe" class="tag tag--me">you</span>
        </h1>
        <p class="muted who__handle">
          {{ member.displayName }}<template v-if="member.handle"> · @{{ member.handle }}</template>
        </p>
      </section>

      <!-- The season in four numbers. -->
      <section class="stats">
        <div class="stat">
          <span class="label">Table</span>
          <span class="stat__n num">{{ record && record.played ? ordinal(record.position) : '–' }}</span>
          <span class="faint stat__sub">{{ record && record.played ? `of ${record.of}` : 'not played yet' }}</span>
        </div>
        <div class="stat">
          <span class="label">Record</span>
          <span class="stat__n num">{{ record ? `${record.won}–${record.lost}` : '0–0' }}</span>
          <span class="faint stat__sub tnum">{{ record ? `${record.points} pts` : '' }}</span>
        </div>
        <div class="stat stat--wide">
          <span class="label">Form</span>
          <span v-if="form.length" class="form" :aria-label="`Last ${form.length}: ${form.join(' ')}`">
            <span v-for="(r, i) in form" :key="i" class="form__pip" :class="r === 'W' ? 'is-w' : 'is-l'">{{ r }}</span>
          </span>
          <span v-else class="faint stat__sub">No results yet</span>
          <span v-if="form.length" class="faint stat__sub">oldest to latest</span>
        </div>
      </section>

      <!-- Against you. -->
      <section v-if="h2h" class="block">
        <h2 class="sect">Against you</h2>
        <p v-if="!h2h.played" class="muted blurb">You have not played each other yet this season.</p>
        <p v-else class="h2h">
          <span class="num h2h__n">{{ h2h.won }}–{{ h2h.lost }}</span>
          <span class="muted">
            {{ h2h.won > h2h.lost ? `${member.teamName} lead` : h2h.won < h2h.lost ? 'You lead' : 'Level' }}
            over {{ h2h.played }} {{ h2h.played === 1 ? 'match' : 'matches' }}
          </span>
        </p>
      </section>

      <!-- The last three. -->
      <section class="block">
        <h2 class="sect">Last results</h2>
        <p v-if="!recent.length" class="muted blurb">Nothing decided yet.</p>
        <ul v-else class="results">
          <li v-for="r in recent" :key="r.fixtureId" class="result">
            <span class="result__wl" :class="r.won ? 'is-w' : 'is-l'">{{ r.won ? 'Won' : 'Lost' }}</span>
            <span class="result__what">
              vs <strong>{{ r.opponent }}</strong>
              <span v-if="STAGE[r.stage]" class="tag">{{ STAGE[r.stage] }}</span>
              <span v-if="r.upset" class="tag tag--new">Upset</span>
              <span class="faint result__meta tnum">
                {{ r.kills.mine }}–{{ r.kills.theirs }}<template v-if="r.gameLength"> · {{ clock(r.gameLength) }}</template>
                · {{ r.dayIndex ? `Day ${r.dayIndex}, ` : '' }}{{ when(r.playedAt) }}
                <template v-if="r.autoPlayed"> · played by the agent</template>
              </span>
            </span>
            <NuxtLink v-if="r.duelId" class="btn btn--quiet btn--sm result__watch" :to="`/duel/${r.duelId}`">Watch</NuxtLink>
          </li>
        </ul>
        <p v-if="recent.length && recent.some((r) => !r.duelId)" class="faint hint">
          A replay can be watched by the two managers who played it.
        </p>
      </section>

      <!-- Their five: whether it is complete, never what is in it. -->
      <section class="block">
        <h2 class="sect">Team</h2>
        <p class="muted blurb">
          <template v-if="member.isMe">
            Your five is {{ data.rosterFilled }}/{{ data.rosterSlots }}.
            <NuxtLink to="/roster">Open your roster</NuxtLink>.
          </template>
          <template v-else>
            {{ data.rosterFilled === data.rosterSlots ? 'A full five is set.' : `${data.rosterFilled}/${data.rosterSlots} roster slots filled.` }}
            Their lineup is revealed when the draft starts, and their collection stays theirs.
          </template>
        </p>

        <template v-if="!member.isMe">
          <button
            class="btn btn--ghost who__act" type="button"
            :disabled="challenging || data.rosterFilled < data.rosterSlots" @click="friendly"
          >
            {{ challenging ? 'Sending' : data.rosterFilled < data.rosterSlots ? 'No full team yet' : 'Send a friendly' }}
          </button>
          <p class="faint hint">A friendly does not count in the table.</p>
        </template>
      </section>
    </template>
  </main>
</template>

<style scoped>
.backlink { display: inline-flex; align-items: center; gap: 4px; min-height: 44px; min-width: 0; margin-left: -6px; padding-right: 8px; font-size: 13.5px; font-weight: 600; color: var(--ink-2); }
.backlink svg { width: 20px; height: 20px; flex: none; }
.backlink:hover { color: var(--ink-1); }

.head-skeleton { height: 28vh; }

.who__name { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-size: clamp(30px, 7vw, 44px); line-height: 0.95; margin: 4px 0 0; overflow-wrap: anywhere; }
.who__handle { font-size: 13.5px; margin: 8px 0 0; }
.who__act { margin-top: 4px; min-height: 44px; }

.stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1px;
  margin-top: 22px;
  border: 1px solid var(--line-1);
  background: var(--line-1);
}
.stat { display: grid; gap: 4px; align-content: start; padding: 14px; background: var(--bg-1); }
.stat--wide { grid-column: 1 / -1; }
.stat__n { font-size: 30px; line-height: 1; }
.stat__sub { font-size: 12px; }
@media (min-width: 640px) {
  .stats { grid-template-columns: 1fr 1fr 2fr; }
  .stat--wide { grid-column: auto; }
}

/* Form: the letter carries it, not the colour alone. */
.form { display: flex; gap: 6px; }
.form__pip {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 2px;
  font-stretch: 80%;
  font-weight: 820;
  font-size: 14px;
}
.form__pip.is-w { background: var(--bg-3); color: var(--ink-1); box-shadow: inset 0 0 0 1px var(--line-3); }
.form__pip.is-l { color: var(--ink-3); box-shadow: inset 0 0 0 1px var(--line-2); }

.block { margin-top: 28px; }
.sect { margin: 0 0 10px; font-stretch: 92%; font-weight: 720; font-size: 17px; }
.blurb { font-size: 13.5px; margin: 0 0 10px; }
.hint { font-size: 12px; margin: 8px 0 0; }

.h2h { display: flex; align-items: baseline; gap: 12px; margin: 0; }
.h2h__n { font-size: 28px; }

.results { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line-1); }
.result {
  display: grid;
  grid-template-columns: 46px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  min-height: 56px;
  padding: 8px 2px;
  border-bottom: 1px solid var(--line-1);
}
.result__wl { font-stretch: 112%; font-size: 11px; font-weight: 780; letter-spacing: 0.12em; text-transform: uppercase; }
.result__wl.is-w { color: var(--ink-1); }
.result__wl.is-l { color: var(--ink-3); }
.result__what { min-width: 0; font-size: 14px; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.result__meta { flex-basis: 100%; font-size: 12px; }
.result__watch { min-height: 44px; }
</style>
