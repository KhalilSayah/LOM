<script setup lang="ts">
import {
  normaliseLeagueCode, MAX_MANAGERS, TEAM_NAME_MAX, seasonShape, kickOffText, zoneCity,
} from '~~/shared/league';

/**
 * Leagues: the ones you are in, and the two ways into a new one.
 *
 * Hosting and joining sit on the same screen because which one you want is decided
 * by somebody else — whoever in the group got there first. Both are one short form,
 * and neither is behind a menu.
 *
 * A league that is still forming is the one waiting on a human, so those sort to the
 * top and say what they are waiting for: more managers, or the owner's thumb.
 * Above them, though, come the leagues with a fixture of mine on the way, soonest
 * first — the list is where somebody checks what they play next.
 */

const data = ref<any>(null);
const loading = ref(true);
const error = ref('');

const message = (e: any, fallback: string) =>
  e?.statusMessage || e?.data?.statusMessage || e?.data?.message || fallback;

async function load() {
  try {
    data.value = await $fetch<any>('/api/league/list');
    error.value = '';
  } catch (e: any) {
    error.value = message(e, 'Could not load your leagues.');
  } finally {
    loading.value = false;
  }
}

function retry() {
  loading.value = true;
  load();
}

// --- hosting -----------------------------------------------------------------

const hosting = ref(false);
const busy = ref(false);
const form = ref({ name: '', timezone: 'Europe/Paris', matchHour: '20:30', teamName: '' });

/** What a full league of six plays; the real length follows whoever joins. */
const fullShape = seasonShape(MAX_MANAGERS);
const smallShape = seasonShape(2);
const hostError = ref('');

onMounted(() => {
  // The league's timezone defaults to the host's own, which is right far more often
  // than any fixed default — and is the thing people forget to change.
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) form.value.timezone = tz;
  } catch { /* a runtime without a zone keeps the default */ }
  load();
});

async function host() {
  if (busy.value) return;
  hostError.value = '';
  busy.value = true;
  try {
    const res = await $fetch<any>('/api/league/create', {
      method: 'POST',
      body: { ...form.value, teamName: form.value.teamName.trim() || undefined },
    });
    await navigateTo(`/leagues/${res.league.id}`);
  } catch (e: any) {
    hostError.value = message(e, 'Could not create that league.');
  } finally {
    busy.value = false;
  }
}

// --- joining -----------------------------------------------------------------

const code = ref('');
const joining = ref(false);
const joinError = ref('');
const typed = computed(() => normaliseLeagueCode(code.value));

async function join() {
  if (joining.value) return;
  joinError.value = '';

  if (!typed.value) {
    joinError.value = 'An invite code is six characters, like H7K2M4.';
    return;
  }

  joining.value = true;
  try {
    const res = await $fetch<any>('/api/league/join', { method: 'POST', body: { code: typed.value } });
    await navigateTo(`/leagues/${res.league.id}`);
  } catch (e: any) {
    joinError.value = message(e, 'Could not join that league.');
  } finally {
    joining.value = false;
  }
}

// --- display -----------------------------------------------------------------

const leagues = computed<any[]>(() => data.value?.leagues ?? []);

/**
 * One way of writing a kick-off (shared/league.ts): "Today 20:30" on a 24-hour clock in
 * the viewer's own zone, with the league's clock beside it when the two differ.
 */
const kickOff = (iso: string | null, leagueTz: string) => kickOffText(iso, { leagueTz });

useHead({ title: 'Leagues — LOM' });
</script>

<template>
  <main class="page">
    <header class="topbar">
      <h1>Leagues</h1>
      <NuxtLink class="topbar__meta" to="/discovery">Find a manager</NuxtLink>
    </header>

    <div v-if="loading" class="skeleton leagues-skeleton" />

    <template v-else>
      <!-- Your leagues. A failed load says so and offers a retry: it is not "no league yet". -->
      <section class="yours">
        <h2 class="sect">Your leagues</h2>

        <div v-if="error && !data" class="notice notice--bad load-error" role="alert">
          <span>{{ error }}</span>
          <button class="btn btn--quiet btn--sm" type="button" @click="retry">Try again</button>
        </div>

        <template v-else>
          <p v-if="error" class="notice notice--bad" role="alert">{{ error }}</p>

          <ul v-if="leagues.length" class="rows">
            <li v-for="l in leagues" :key="l.id" class="row">
              <NuxtLink class="league" :to="`/leagues/${l.id}`">
                <span class="league__head">
                  <strong class="league__name">{{ l.name }}</strong>
                  <span v-if="l.status === 'FORMING'" class="tag">Forming</span>
                  <span v-else-if="l.status === 'ACTIVE'" class="tag tag--live">Season on</span>
                  <span v-else class="label league__done">Finished</span>
                </span>

                <span class="league__meta tnum">
                  {{ l.memberCount }} of {{ l.maxMembers }} managers · {{ l.matchHour }} {{ zoneCity(l.timezone) }} time
                </span>

                <span v-if="l.next" class="league__next">
                  Day {{ l.next.dayIndex }} · vs <strong>{{ l.next.opponent }}</strong>
                  <span class="faint tnum">
                    · <template v-if="l.next.started && !l.next.duelId">kicked off {{ kickOff(l.next.scheduledAt, l.timezone).text }}</template>
                    <template v-else>{{ kickOff(l.next.scheduledAt, l.timezone).text }}</template>
                    <template v-if="kickOff(l.next.scheduledAt, l.timezone).league"> ({{ kickOff(l.next.scheduledAt, l.timezone).league }})</template>
                  </span>
                  <span v-if="l.next.playable" class="tag tag--live league__live">{{ l.next.duelId ? 'In the room' : 'Lobby open' }}</span>
                </span>
                <span v-else-if="l.status === 'FORMING'" class="league__next faint">
                  {{ l.memberCount < 2
                    ? 'Waiting for somebody to join'
                    : l.iAmOwner ? 'Ready when you are' : 'Waiting for the host to start it' }}
                </span>
                <span v-else class="league__next faint">No fixture scheduled</span>

                <svg class="ico league__go" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
              </NuxtLink>
            </li>
          </ul>

          <div v-else class="empty">
            <h2>No league yet</h2>
            <p>Host one and send the link to the group, or paste the code somebody sent you.</p>
          </div>
        </template>
      </section>

      <!-- Host -->
      <section class="panel block">
        <h2 class="sect">Host a league</h2>

        <template v-if="!hosting">
          <p class="muted blurb">
            Two to {{ MAX_MANAGERS }} managers, one match an evening, about a fortnight of it.
            You pick the hour; everyone gets a fixture list the moment you start the season.
          </p>
          <button class="btn btn--block" type="button" @click="hosting = true">New league</button>
        </template>

        <form v-else class="form" @submit.prevent="host">
          <div class="field">
            <label for="lname">League name</label>
            <input id="lname" v-model="form.name" maxlength="40" placeholder="Sunday Night Rift" required>
          </div>

          <div class="form__row">
            <div class="field">
              <label for="lhour">Match hour</label>
              <input id="lhour" v-model="form.matchHour" type="time" required>
            </div>
            <div class="field">
              <label for="lteam">Your team name</label>
              <input id="lteam" v-model="form.teamName" :maxlength="TEAM_NAME_MAX" placeholder="Your name" autocomplete="off">
            </div>
          </div>

          <div class="field">
            <label for="ltz">Timezone</label>
            <input id="ltz" v-model="form.timezone" placeholder="Europe/Paris" required>
          </div>

          <p class="faint hint">
            The match hour is wall-clock time in that zone, so it survives the clocks changing.
            You can change it until the season starts.
          </p>

          <!-- Season length is not a setting: it is what "everyone twice" takes. -->
          <p class="faint hint">
            The season length follows the number of managers, so everyone plays everyone
            twice, once from each side: {{ fullShape.matchDays }} match evenings and
            {{ fullShape.playoffDays }} playoff days for {{ MAX_MANAGERS }}
            (about {{ fullShape.totalDays }} days), {{ smallShape.matchDays }} head-to-heads
            and a final for two.
          </p>

          <p v-if="hostError" class="notice notice--bad form__error" role="alert">{{ hostError }}</p>

          <div class="form__acts">
            <button class="btn btn--quiet" type="button" @click="hosting = false">Cancel</button>
            <button class="btn" type="submit" :disabled="busy">
              {{ busy ? 'Creating' : 'Create league' }}
            </button>
          </div>
        </form>
      </section>

      <!-- Join -->
      <section class="panel block">
        <h2 class="sect">Join with a code</h2>
        <form class="join" @submit.prevent="join">
          <input
            v-model="code" class="join__input" inputmode="text" autocapitalize="characters"
            autocomplete="off" spellcheck="false" maxlength="40" placeholder="H7K2M4"
            aria-label="Invite code or link"
          >
          <button class="btn btn--ghost" type="submit" :disabled="joining">
            {{ joining ? 'Joining' : 'Join' }}
          </button>
        </form>
        <p v-if="joinError" class="notice notice--bad join__error" role="alert">{{ joinError }}</p>
        <p v-else class="faint hint">A whole invite link works too. Paste it and tap Join.</p>
      </section>
    </template>
  </main>
</template>

<style scoped>
.leagues-skeleton { height: 26vh; }

.sect { margin: 0 0 12px; font-stretch: 92%; font-weight: 720; font-size: 17px; }
.panel .sect { margin-bottom: 8px; }

.load-error { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }

/* One surface, rows split by keylines. */
.rows { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line-1); }
.row { border-bottom: 1px solid var(--line-1); }
.league {
  position: relative;
  display: grid;
  gap: 4px;
  min-height: 44px;
  padding: 13px 32px 13px 4px;
  color: inherit;
  text-decoration: none;
}
.league__head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
.league__name { font-stretch: 85%; font-size: 19px; font-weight: 800; line-height: 1.1; }
.league__done { font-size: 10.5px; }
.league__meta { font-size: 12.5px; color: var(--ink-3); }
.league__next { font-size: 13.5px; color: var(--ink-2); }
.league__next strong { color: var(--ink-1); }
.league__live { margin-left: 6px; vertical-align: 1px; }
.league__go { position: absolute; right: 4px; top: 50%; width: 20px; height: 20px; margin-top: -10px; color: var(--ink-3); }
@media (hover: hover) and (pointer: fine) {
  .league:hover { background: var(--bg-2); }
  .league:hover .league__go { color: var(--ink-1); }
}

.block { margin-top: 24px; }
.blurb { font-size: 13.5px; margin: 0 0 14px; }
.form { display: grid; gap: 12px; margin-top: 10px; }
.form__row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.form__acts { display: flex; justify-content: flex-end; gap: 8px; }
.form__error { margin: 0; }
.hint { font-size: 12px; margin: 8px 0 0; }

.join { display: flex; gap: 8px; margin-top: 10px; }
.join__input {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 48px;
  padding: 0 14px;
  border: 1px solid var(--line-2);
  border-radius: 2px;
  background: var(--bg-0);
  color: var(--ink-1);
  font-family: inherit;
  font-stretch: 85%;
  font-size: 18px;
  font-weight: 760;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.join__input:focus { border-color: var(--teal-2); outline: none; }
.join__input::placeholder { color: var(--ink-4); }
.join__error { margin: 10px 0 0; }
</style>
