<script setup lang="ts">
/**
 * Duels: what is waiting on you, what is waiting on them, and what already happened.
 *
 * Incoming challenges come first because they are the only thing here that needs a
 * decision. Everything else is a link.
 */

const data = ref<any>(null);
const loading = ref(true);
const error = ref('');
const busy = ref<string | null>(null);

async function load() {
  try {
    data.value = await $fetch<any>('/api/duel/list');
    error.value = '';
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.message || 'Could not load your duels.';
  } finally {
    loading.value = false;
  }
}

async function respond(duelId: string, accept: boolean) {
  if (busy.value) return;
  busy.value = duelId;
  try {
    const res = await $fetch<any>('/api/duel/respond', { method: 'POST', body: { duelId, accept } });
    if (accept && res.status === 'DRAFTING') return navigateTo(`/duel/${duelId}`);
    await load();
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.message || 'That did not go through.';
    await load();
  } finally {
    busy.value = null;
  }
}

onMounted(load);
useHead({ title: 'Duels — LOM' });
</script>

<template>
  <main class="page">
    <header class="topbar">
      <h1>Duels</h1>
      <NuxtLink class="topbar__meta" to="/discovery">Find someone</NuxtLink>
    </header>

    <p v-if="error" class="notice notice--bad">{{ error }}</p>
    <div v-if="loading" class="skeleton duels-skeleton" />

    <template v-else-if="data">
      <section v-if="data.incoming.length" class="block">
        <p class="eyebrow">Waiting on you</p>
        <ul class="list">
          <li v-for="d in data.incoming" :key="d.id" class="panel row">
            <span class="row__who"><strong>{{ d.opponent }}</strong> challenged you</span>
            <span class="row__acts">
              <button class="btn btn--quiet" type="button" :disabled="busy === d.id" @click="respond(d.id, false)">
                Decline
              </button>
              <button class="btn" type="button" :disabled="busy === d.id" @click="respond(d.id, true)">
                {{ busy === d.id ? 'Starting' : 'Accept' }}
              </button>
            </span>
          </li>
        </ul>
      </section>

      <section v-if="data.drafting.length" class="block">
        <p class="eyebrow">Drafting now</p>
        <ul class="list">
          <li v-for="d in data.drafting" :key="d.id" class="panel row">
            <span class="row__who">
              vs <strong>{{ d.opponent }}</strong>
              <span class="faint"> · {{ d.side }} side · action {{ Math.min(d.turn + 1, 20) }} of 20</span>
            </span>
            <NuxtLink class="btn" :to="`/duel/${d.id}`">Back to the draft</NuxtLink>
          </li>
        </ul>
      </section>

      <section v-if="data.outgoing.length" class="block">
        <p class="eyebrow">Waiting on them</p>
        <ul class="list">
          <li v-for="d in data.outgoing" :key="d.id" class="panel row">
            <span class="row__who">You challenged <strong>{{ d.opponent }}</strong></span>
            <button class="btn btn--quiet" type="button" :disabled="busy === d.id" @click="respond(d.id, false)">
              Withdraw
            </button>
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
            </span>
            <NuxtLink class="btn btn--quiet" :to="`/duel/${d.id}`">See it</NuxtLink>
          </li>
        </ul>
      </section>

      <p
        v-if="!data.incoming.length && !data.outgoing.length && !data.drafting.length && !data.finished.length"
        class="muted empty"
      >
        No duels yet. Find a manager in <NuxtLink to="/discovery">Discover</NuxtLink> and challenge them —
        you draft against each other, ban and pick, and the match plays itself out.
      </p>
    </template>
  </main>
</template>

<style scoped>
.duels-skeleton { height: 40vh; }
.block { margin-top: 14px; }
.list { list-style: none; padding: 0; margin: 6px 0 0; display: grid; gap: 8px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.row__who { font-size: 14px; min-width: 0; }
.row__acts { display: flex; gap: 8px; }
.is-won { color: var(--good, #7df0dc); }
.is-lost { color: #ff8a8a; }
.empty { text-align: center; padding: 28px 0; font-size: 14px; }
</style>
