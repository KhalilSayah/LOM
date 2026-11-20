<script setup lang="ts">
/**
 * The invite link.
 *
 * It does not join you. Joining a league is agreeing to turn up at a fixed hour
 * every evening for a fortnight, and a link that commits you to that the instant you
 * tap it in a group chat is a trap — somebody's thumb finds it while scrolling. So
 * this screen says whose league it is, who is in it and when they play, and then
 * asks.
 *
 * Already a member, following your own link back: it says so and shows the way in,
 * rather than an error about a thing you have already done.
 */

const route = useRoute();
const code = computed(() => String(route.params.code || ''));

const data = ref<any>(null);
const loading = ref(true);
const error = ref('');
const joining = ref(false);

const message = (e: any, fallback: string) =>
  e?.statusMessage || e?.data?.statusMessage || e?.data?.message || fallback;

async function load() {
  loading.value = true;
  try {
    data.value = await $fetch<any>('/api/league/preview', { query: { code: code.value } });
    error.value = '';
  } catch (e: any) {
    error.value = message(e, 'Could not open that invite.');
  } finally {
    loading.value = false;
  }
}

watch(code, load, { immediate: true });

async function join() {
  if (joining.value) return;
  joining.value = true;
  try {
    const res = await $fetch<any>('/api/league/join', { method: 'POST', body: { code: code.value } });
    await navigateTo(`/leagues/${res.league.id}`);
  } catch (e: any) {
    error.value = message(e, 'Could not join that league.');
    await load();
  } finally {
    joining.value = false;
  }
}

const league = computed<any>(() => data.value?.league ?? null);

useHead(() => ({
  title: league.value ? `Join ${league.value.name} — LOM` : 'Invite — LOM',
}));
</script>

<template>
  <main class="page">
    <header class="topbar">
      <NuxtLink class="btn btn--quiet" to="/leagues">Leagues</NuxtLink>
      <span class="topbar__meta">Invite</span>
    </header>

    <p v-if="error" class="notice notice--bad">{{ error }}</p>

    <div v-if="loading" class="skeleton invite-skeleton" />

    <section v-else-if="league" class="panel invite">
      <p class="eyebrow">{{ data.host }} invited you to</p>
      <h1 class="invite__name">{{ league.name }}</h1>

      <p class="muted invite__meta">
        {{ league.memberCount }} of {{ league.maxMembers }} managers ·
        matches at {{ league.matchHour }} {{ league.timezone }} ·
        {{ league.seasonLengthDays }}-day season
      </p>

      <ul class="who">
        <li v-for="(m, i) in data.members" :key="i" class="who__row">
          {{ m.teamName }}<span v-if="m.isOwner" class="faint"> · host</span>
        </li>
      </ul>

      <template v-if="data.alreadyIn">
        <p class="notice">You are already in this league.</p>
        <NuxtLink class="btn btn--block" :to="`/leagues/${league.id}`">Open it</NuxtLink>
      </template>

      <template v-else-if="league.status !== 'FORMING'">
        <p class="notice notice--bad">
          This season has already started, so the invite has closed.
        </p>
      </template>

      <template v-else-if="data.full">
        <p class="notice notice--bad">
          All {{ league.maxMembers }} seats are taken.
        </p>
      </template>

      <template v-else>
        <button class="btn btn--block" type="button" :disabled="joining" @click="join">
          {{ joining ? 'Joining' : 'Join this league' }}
        </button>
        <p class="faint hint">
          You bring the collection you already have. Nothing is taken from it, and you can
          leave while the league is still forming.
        </p>
      </template>
    </section>
  </main>
</template>

<style scoped>
.invite-skeleton { height: 30vh; }
.invite { margin-top: 10vh; text-align: center; }
.invite__name { font-family: var(--font-display); font-size: 27px; margin: 6px 0 0; }
.invite__meta { font-size: 13px; margin: 8px 0 14px; }

.who {
  list-style: none;
  padding: 10px 0;
  margin: 0 0 16px;
  display: grid;
  gap: 3px;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}
.who__row { font-size: 14px; }

.hint { font-size: 12px; margin: 10px 0 0; }
</style>
