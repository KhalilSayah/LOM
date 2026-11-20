<script setup lang="ts">
/**
 * Battle.
 *
 * One button, the size of a thumb, in the middle of the screen. That is the whole brief and
 * everything else on this page is secondary to it — because the thing the old duels screen
 * got wrong was not its layout, it was asking you to go and find somebody first. A list of
 * challenges you have sent is a to-do list. A button that puts you in a game is a game.
 *
 * What is below it, in order: the room you are already in (because being put back into it
 * matters more than anything else here), friendlies waiting on an answer, and what you have
 * played. Finding a specific manager to challenge still exists and is deliberately one line
 * of text rather than a second button — it is the rarer intention now.
 */

const { searching, waiting, elapsed, botOffered, error: queueError, busy, search, cancel, playBot, restore } =
  useDuelQueue();

const data = ref<any>(null);
const loading = ref(true);
const listError = ref('');
const responding = ref<string | null>(null);

const error = computed(() => queueError.value || listError.value);

async function load() {
  try {
    data.value = await $fetch<any>('/api/duel/list');
    listError.value = '';
  } catch (e: any) {
    listError.value = e?.data?.statusMessage || e?.message || 'Could not load your duels.';
  } finally {
    loading.value = false;
  }
}

async function respond(duelId: string, accept: boolean) {
  if (responding.value) return;
  responding.value = duelId;
  try {
    const res = await $fetch<any>('/api/duel/respond', { method: 'POST', body: { duelId, accept } });
    if (accept && res.status === 'DRAFTING') return navigateTo(`/duel/${duelId}`);
    await load();
  } catch (e: any) {
    listError.value = e?.data?.statusMessage || e?.message || 'That did not go through.';
    await load();
  } finally {
    responding.value = null;
  }
}

const seconds = computed(() => Math.floor(elapsed.value));

/** The search spinner's four dots, so it reads as activity rather than a frozen screen. */
const pulse = computed(() => Math.floor(elapsed.value * 2) % 4);

onMounted(() => { restore(); load(); });
useHead({ title: 'Battle — LOM' });
</script>

<template>
  <main class="page">
    <header class="topbar">
      <h1>Battle</h1>
      <NuxtLink class="topbar__meta" to="/discovery">Find a manager</NuxtLink>
    </header>

    <p v-if="error" class="notice notice--bad">{{ error }}</p>

    <!-- The button. Everything else on this screen is secondary to it. -->
    <section class="arena" :class="{ 'is-searching': searching }">
      <template v-if="!searching">
        <p class="arena__blurb">
          Draft against another manager, live, and watch the match play out together.
        </p>
        <button class="battle" type="button" :disabled="busy" @click="search">
          <span class="battle__word">{{ busy ? 'Starting' : 'Battle' }}</span>
          <span class="battle__sub">
            {{ waiting ? `${waiting} searching now` : 'Draft and play, start to finish' }}
          </span>
        </button>
      </template>

      <template v-else>
        <p class="eyebrow">Searching</p>
        <p class="arena__hunt">
          <span v-for="n in 4" :key="n" class="dot" :class="{ 'is-on': pulse === n - 1 }" />
        </p>
        <p class="arena__clock tnum">{{ seconds }}s</p>
        <p class="arena__note">
          <template v-if="waiting">
            {{ waiting }} other {{ waiting === 1 ? 'manager is' : 'managers are' }} searching —
            pairing you now.
          </template>
          <template v-else>
            Nobody else is searching yet. You will be put in the moment somebody is.
          </template>
        </p>

        <!-- The search carries on underneath this. A human who turns up still wins. -->
        <div v-if="botOffered" class="arena__bot">
          <p class="arena__note">Rather not wait?</p>
          <button class="btn" type="button" :disabled="busy" @click="playBot">
            Draft against the agent
          </button>
        </div>

        <button class="btn btn--quiet arena__cancel" type="button" @click="cancel">
          Stop searching
        </button>
      </template>
    </section>

    <div v-if="loading" class="skeleton duels-skeleton" />

    <template v-else-if="data">
      <!-- Being put back into a live room beats everything else on this page. -->
      <section v-if="data.live?.length" class="block">
        <p class="eyebrow">You are in a room</p>
        <ul class="list">
          <li v-for="d in data.live" :key="d.id" class="panel row row--live">
            <span class="row__who">
              vs <strong>{{ d.opponent }}</strong>
              <span class="faint">
                ·
                <template v-if="d.status === 'WATCHING'">watching the match</template>
                <template v-else>{{ d.side }} side · action {{ Math.min(d.turn + 1, 20) }} of 20</template>
              </span>
            </span>
            <NuxtLink class="btn" :to="`/duel/${d.id}`">Rejoin</NuxtLink>
          </li>
        </ul>
      </section>

      <section v-if="data.incoming.length" class="block">
        <p class="eyebrow">Friendly, waiting on you</p>
        <ul class="list">
          <li v-for="d in data.incoming" :key="d.id" class="panel row">
            <span class="row__who"><strong>{{ d.opponent }}</strong> challenged you</span>
            <span class="row__acts">
              <button
                class="btn btn--quiet" type="button"
                :disabled="responding === d.id" @click="respond(d.id, false)"
              >Decline</button>
              <button
                class="btn" type="button"
                :disabled="responding === d.id" @click="respond(d.id, true)"
              >{{ responding === d.id ? 'Starting' : 'Accept' }}</button>
            </span>
          </li>
        </ul>
      </section>

      <section v-if="data.outgoing.length" class="block">
        <p class="eyebrow">Friendly, waiting on them</p>
        <ul class="list">
          <li v-for="d in data.outgoing" :key="d.id" class="panel row">
            <span class="row__who">You challenged <strong>{{ d.opponent }}</strong></span>
            <button
              class="btn btn--quiet" type="button"
              :disabled="responding === d.id" @click="respond(d.id, false)"
            >Withdraw</button>
          </li>
        </ul>
      </section>

      <section v-if="data.finished.length" class="block">
        <p class="eyebrow">Played</p>
        <ul class="list">
          <li v-for="d in data.finished" :key="d.id" class="panel row">
            <span class="row__who">
              <strong :class="d.won ? 'is-won' : 'is-lost'">{{ d.won ? 'Won' : 'Lost' }}</strong>
              vs {{ d.opponent }}
              <span v-if="d.isBot" class="faint"> · agent</span>
            </span>
            <NuxtLink class="btn btn--quiet" :to="`/duel/${d.id}`">See it</NuxtLink>
          </li>
        </ul>
      </section>
    </template>
  </main>
</template>

<style scoped>
.duels-skeleton { height: 22vh; }

/* --- the arena ----------------------------------------------------------
   The one part of this screen that is allowed to be loud. */

.arena {
  display: grid;
  justify-items: center;
  gap: 10px;
  text-align: center;
  padding: 26px 16px 30px;
}
.arena__blurb { font-size: 14px; color: var(--ink-dim, #8fa3c0); max-width: 34ch; margin: 0; }

.battle {
  display: grid;
  gap: 2px;
  padding: 18px 42px;
  border: none;
  border-radius: 16px;
  cursor: pointer;
  color: #06121a;
  font: inherit;
  background: linear-gradient(180deg, #8ae7ff, #47c4ec 60%, #2fa7d0);
  box-shadow: 0 10px 28px -10px rgba(71, 196, 236, 0.75), inset 0 1px 0 rgba(255, 255, 255, 0.5);
  transition: transform 90ms ease, box-shadow 160ms ease;
}
.battle:active { transform: translateY(2px); box-shadow: 0 4px 14px -8px rgba(71, 196, 236, 0.8); }
.battle:disabled { opacity: 0.6; cursor: progress; }
.battle__word {
  font-family: var(--font-display, inherit);
  font-size: 30px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.battle__sub { font-size: 11.5px; font-weight: 600; opacity: 0.74; }

.arena.is-searching { padding-top: 30px; }
.arena__hunt { display: flex; gap: 7px; margin: 2px 0; }
.dot {
  width: 9px; height: 9px; border-radius: 50%;
  background: var(--line, #2b3448);
  transition: background 140ms ease, transform 140ms ease;
}
.dot.is-on { background: var(--accent, #67d3f2); transform: scale(1.35); }
.arena__clock { font-size: 26px; font-weight: 700; font-family: var(--font-display, inherit); }
.arena__note { font-size: 13px; color: var(--ink-dim, #8fa3c0); max-width: 36ch; margin: 0; }
.arena__bot {
  display: grid; justify-items: center; gap: 7px;
  margin-top: 10px; padding-top: 14px;
  border-top: 1px solid var(--line, #2b3448);
  width: 100%; max-width: 300px;
}
.arena__cancel { margin-top: 6px; }

.block { margin-top: 14px; }
.list { list-style: none; padding: 0; margin: 6px 0 0; display: grid; gap: 8px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.row--live { border-color: var(--accent, #67d3f2); }
.row__who { font-size: 14px; min-width: 0; }
.row__acts { display: flex; gap: 8px; }
.is-won { color: var(--good, #7df0dc); }
.is-lost { color: #ff8a8a; }
</style>
