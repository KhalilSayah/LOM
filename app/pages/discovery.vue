<script setup lang="ts">
import { formatShareCode, normaliseShareCode } from '~~/shared/shareCode';

/**
 * Discovery: hand out your code, type in someone else's, and keep what you find.
 *
 * The found list is the point of the screen. Searching a code is a one-off act — you
 * do it when a friend reads their code out — and everything after that is walking
 * back into a collection you have already found. So the list is what the screen is
 * mostly showing, and the search field sits above it rather than being the screen.
 */

const BANDS = ['ICON', 'LEGENDARY', 'EPIC', 'RARE', 'COMMON'];

const state = ref<any>(null);
const loading = ref(true);
const loadError = ref('');

const query = ref('');
const searching = ref(false);
const searchError = ref('');
const justFound = ref<string | null>(null);

const typed = computed(() => normaliseShareCode(query.value));

const message = (e: any, fallback: string) =>
  e?.statusMessage || e?.data?.statusMessage || e?.data?.message || fallback;

async function load() {
  try {
    state.value = await $fetch<any>('/api/discovery/list');
    loadError.value = '';
  } catch (e: any) {
    loadError.value = message(e, 'Could not load your managers.');
  } finally {
    loading.value = false;
  }
}

async function find() {
  if (searching.value) return;
  searchError.value = '';
  justFound.value = null;

  // Checked here as well as at the endpoint so a mistyped code answers instantly and
  // in the same words, rather than after a round trip.
  if (!typed.value) {
    searchError.value = 'A share code is eight characters, like 7K2M-4QXP.';
    return;
  }

  searching.value = true;
  try {
    const result = await $fetch<any>('/api/discovery/find', {
      method: 'POST',
      body: { code: typed.value },
    });
    query.value = '';
    justFound.value = result.manager.shareCode;
    await load();
  } catch (e: any) {
    searchError.value = message(e, 'That search did not work.');
  } finally {
    searching.value = false;
  }
}

async function forget(code: string) {
  try {
    await $fetch('/api/discovery/forget', { method: 'POST', body: { code } });
    if (justFound.value === code) justFound.value = null;
    await load();
  } catch (e: any) {
    loadError.value = message(e, 'Could not drop that manager.');
  }
}

onMounted(load);

useHead({ title: 'Discovery — LOM' });

// --- duels -------------------------------------------------------------------

/**
 * Challenging someone is the one thing on this screen that asks something of them, so it
 * says what happened rather than silently succeeding: a challenge sits waiting until they
 * answer it, and there is nothing to watch in the meantime.
 */
const challenging = ref<string | null>(null);
const duelNote = ref('');

async function challenge(target: { id: string; displayName?: string; handle?: string }) {
  if (challenging.value) return;
  challenging.value = target.id;
  duelNote.value = '';
  try {
    await $fetch('/api/duel/challenge', { method: 'POST', body: { opponentId: target.id } });
    duelNote.value = `Challenge sent to ${target.displayName || target.handle}. It is waiting for them to accept.`;
  } catch (e: any) {
    duelNote.value = e?.data?.statusMessage || e?.message || 'Could not send that challenge.';
  } finally {
    challenging.value = null;
  }
}
</script>

<template>
  <main class="page">
    <header class="topbar">
      <h1>Discovery</h1>
      <span v-if="state?.found?.length" class="topbar__meta">
        {{ state.found.length }} {{ state.found.length === 1 ? 'manager' : 'managers' }}
      </span>
    </header>

    <ShareCode :code="state?.me?.shareCode ?? null" :handle="state?.me?.handle ?? null" />

    <section class="panel find">
      <p class="eyebrow">Find a manager</p>
      <form class="find__form" @submit.prevent="find">
        <input
          v-model="query"
          class="find__input"
          type="text"
          autocapitalize="characters"
          autocomplete="off"
          spellcheck="false"
          maxlength="20"
          placeholder="7K2M-4QXP"
          aria-label="Share code"
        >
        <button class="btn" type="submit" :disabled="searching">
          {{ searching ? 'Looking…' : 'Find' }}
        </button>
      </form>
      <p v-if="searchError" class="notice notice--bad find__msg">{{ searchError }}</p>
      <p v-else class="muted find__hint">
        Case and dashes do not matter. O reads as 0, and I and L read as 1.
      </p>
    </section>

    <p v-if="loadError" class="notice notice--bad find__msg">{{ loadError }}</p>
    <p v-if="duelNote" class="notice find__msg">{{ duelNote }}</p>

    <div v-if="loading" class="found">
      <div v-for="i in 2" :key="i" class="skeleton found__skeleton" />
    </div>

    <div v-else-if="!state?.found?.length" class="empty">
      <h2>Nobody yet</h2>
      <p>Ask another manager for their code. Once you have found them, they stay here.</p>
    </div>

    <ul v-else class="found">
      <li
        v-for="entry in state.found"
        :key="entry.manager.id"
        class="panel mgr"
        :class="{ 'is-new': entry.manager.shareCode === justFound }"
      >
        <div class="mgr__head">
          <div>
            <p class="mgr__name">{{ entry.manager.displayName }}</p>
            <p class="muted mgr__handle">@{{ entry.manager.handle }}</p>
          </div>
          <button
            class="mgr__forget"
            type="button"
            :aria-label="`Forget ${entry.manager.handle}`"
            @click="forget(entry.manager.shareCode)"
          >×</button>
        </div>

        <p class="mgr__total">
          <span class="tnum mgr__n">{{ entry.collection.total }}</span>
          <span class="mgr__unit">{{ entry.collection.total === 1 ? 'card' : 'cards' }}</span>
        </p>

        <ul class="mgr__bands">
          <li v-for="b in BANDS" :key="b" :class="{ 'is-zero': !entry.collection.bands[b] }">
            <span class="rarity-dot" :class="'is-' + b.toLowerCase()" />
            <span class="tnum">{{ entry.collection.bands[b] || 0 }}</span>
          </li>
        </ul>

        <p v-if="entry.collection.best" class="muted mgr__best">
          Best: {{ entry.collection.best.playerName }}
          <template v-if="entry.collection.best.season">{{ entry.collection.best.season }}</template>
          · {{ entry.collection.best.ovr }} OVR
        </p>
        <p v-else class="muted mgr__best">No cards opened yet.</p>

        <div class="mgr__foot">
          <span class="faint mgr__code tnum">{{ formatShareCode(entry.manager.shareCode) }}</span>
          <NuxtLink class="btn btn--quiet" :to="`/m/${entry.manager.shareCode}`">
            See collection
          </NuxtLink>
          <button
            class="btn btn--quiet"
            type="button"
            :disabled="challenging === entry.manager.id"
            @click="challenge(entry.manager)"
          >
            {{ challenging === entry.manager.id ? 'Sending' : 'Duel' }}
          </button>
        </div>
      </li>
    </ul>
  </main>
</template>

<style scoped>
.find { margin-top: 12px; }
.find__form { display: flex; gap: 8px; margin-top: 10px; }
.find__input {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 48px;
  padding: 0 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--sunken);
  color: var(--ink);
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.find__input:focus { border-color: var(--accent); outline: none; }
.find__input::placeholder { color: var(--ink-faint); }
.find__msg { margin: 10px 0 0; }
.find__hint { font-size: 12.5px; line-height: 1.5; margin: 10px 0 0; }

.found { list-style: none; margin: 14px 0 0; padding: 0; display: grid; gap: 10px; }
.found__skeleton { height: 182px; border-radius: var(--radius); }

.mgr.is-new { border-color: var(--accent); }
.mgr__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.mgr__name { font-family: var(--font-display); font-size: 19px; font-weight: 700; margin: 0; }
.mgr__handle { font-size: 13px; margin: 1px 0 0; }
.mgr__forget {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--ink-faint);
  font-size: 22px;
  line-height: 1;
  padding: 4px 8px;
  margin: -4px -8px 0 0;
  cursor: pointer;
}
.mgr__forget:hover { color: var(--bad); }

.mgr__total { display: flex; align-items: baseline; gap: 7px; margin: 12px 0 0; }
.mgr__n { font-family: var(--font-display); font-size: 27px; font-weight: 700; }
.mgr__unit {
  font-family: var(--font-label);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--ink-dim);
}

.mgr__bands { list-style: none; display: flex; flex-wrap: wrap; gap: 12px; margin: 8px 0 0; padding: 0; }
.mgr__bands li { display: flex; align-items: center; gap: 6px; font-size: 13.5px; font-weight: 600; }
.mgr__bands li.is-zero { opacity: 0.35; }

.mgr__best { font-size: 13.5px; margin: 10px 0 0; }

.mgr__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
.mgr__code { font-size: 13px; letter-spacing: 0.1em; }
</style>
