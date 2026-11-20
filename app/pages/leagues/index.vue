<script setup lang="ts">
import { normaliseLeagueCode, MAX_MANAGERS } from '~~/shared/league';

/**
 * Leagues: the ones you are in, and the two ways into a new one.
 *
 * Hosting and joining sit on the same screen because which one you want is decided
 * by somebody else — whoever in the group got there first. Both are one short form,
 * and neither is behind a menu.
 *
 * A league that is still forming is the one waiting on a human, so those sort to the
 * top and say what they are waiting for: more managers, or the owner's thumb.
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

// --- hosting -----------------------------------------------------------------

const hosting = ref(false);
const busy = ref(false);
const form = ref({ name: '', timezone: 'Europe/Paris', matchHour: '20:30', seasonLengthDays: 14 });
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
    const res = await $fetch<any>('/api/league/create', { method: 'POST', body: form.value });
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

const kickOff = (iso: string | null) => {
  if (!iso) return '';
  const at = new Date(iso);
  const today = new Date();
  const sameDay = at.toDateString() === today.toDateString();
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `tonight ${time}`;
  const tomorrow = new Date(today.getTime() + 86400000);
  if (at.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  return `${at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
};

useHead({ title: 'Leagues — LOM' });
</script>

<template>
  <main class="page">
    <header class="topbar">
      <h1>Leagues</h1>
      <NuxtLink class="topbar__meta" to="/discovery">Find a manager</NuxtLink>
    </header>

    <p v-if="error" class="notice notice--bad">{{ error }}</p>

    <div v-if="loading" class="skeleton leagues-skeleton" />

    <template v-else>
      <ul v-if="leagues.length" class="list">
        <li v-for="l in leagues" :key="l.id" class="panel league">
          <NuxtLink class="league__link" :to="`/leagues/${l.id}`">
            <span class="league__head">
              <strong class="league__name">{{ l.name }}</strong>
              <span class="league__status" :class="`is-${l.status.toLowerCase()}`">
                {{ l.status === 'FORMING' ? 'Forming' : l.status === 'ACTIVE' ? 'Season on' : 'Finished' }}
              </span>
            </span>

            <span class="league__meta">
              {{ l.memberCount }} of {{ l.maxMembers }} managers · {{ l.matchHour }} {{ l.timezone }}
            </span>

            <span v-if="l.next" class="league__next">
              Day {{ l.next.dayIndex }} · vs <strong>{{ l.next.opponent }}</strong>
              <span class="faint"> · {{ kickOff(l.next.scheduledAt) }}</span>
            </span>
            <span v-else-if="l.status === 'FORMING'" class="league__next faint">
              {{ l.memberCount < 2
                ? 'Waiting for somebody to join'
                : l.iAmOwner ? 'Ready when you are' : 'Waiting for the owner to start it' }}
            </span>
            <span v-else class="league__next faint">No fixture scheduled</span>
          </NuxtLink>
        </li>
      </ul>

      <div v-else class="empty">
        <h2>No league yet</h2>
        <p>Host one and send the link to the group, or paste the code somebody sent you.</p>
      </div>

      <!-- Host -->
      <section class="panel block">
        <p class="eyebrow">Host a league</p>

        <template v-if="!hosting">
          <p class="muted blurb">
            Two to {{ MAX_MANAGERS }} managers, one match an evening, a fortnight of it.
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
              <label for="ldays">Season days</label>
              <input id="ldays" v-model.number="form.seasonLengthDays" type="number" min="2" max="60">
            </div>
          </div>

          <div class="field">
            <label for="ltz">Timezone</label>
            <input id="ltz" v-model="form.timezone" placeholder="Europe/Paris" required>
          </div>

          <p class="faint hint">
            The match hour is wall-clock time in that zone, so it survives the clocks changing.
          </p>

          <p v-if="hostError" class="notice notice--bad">{{ hostError }}</p>

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
        <p class="eyebrow">Join with a code</p>
        <form class="join" @submit.prevent="join">
          <input
            v-model="code" class="join__input" inputmode="text" autocapitalize="characters"
            spellcheck="false" maxlength="40" placeholder="H7K2M4" aria-label="Invite code or link"
          >
          <button class="btn" type="submit" :disabled="joining">
            {{ joining ? 'Joining' : 'Join' }}
          </button>
        </form>
        <p class="faint hint">A whole invite link works too — paste it and tap Join.</p>
        <p v-if="joinError" class="notice notice--bad">{{ joinError }}</p>
      </section>
    </template>
  </main>
</template>

<style scoped>
.leagues-skeleton { height: 26vh; }

.list { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
.league { padding: 0; }
.league__link {
  display: grid;
  gap: 4px;
  padding: 13px 14px;
  color: inherit;
  text-decoration: none;
}
.league__head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.league__name { font-family: var(--font-display); font-size: 17px; }
.league__status {
  flex: none;
  font-family: var(--font-label);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ink-faint);
}
.league__status.is-active { color: var(--accent); }
.league__status.is-forming { color: var(--warn); }
.league__meta { font-size: 12.5px; color: var(--ink-dim); }
.league__next { font-size: 13.5px; }

.block { margin-top: 14px; }
.blurb { font-size: 13.5px; margin: 6px 0 12px; }
.form { display: grid; gap: 11px; margin-top: 10px; }
.form__row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.form__acts { display: flex; justify-content: flex-end; gap: 8px; }
.hint { font-size: 12px; margin: 8px 0 0; }

.join { display: flex; gap: 8px; margin-top: 8px; }
.join__input {
  flex: 1;
  min-width: 0;
  min-height: 44px;
  padding: 0 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--sunken);
  color: var(--ink);
  font-family: var(--font-display);
  font-size: 16px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}
.join__input:focus { border-color: var(--accent); outline: none; }
</style>
