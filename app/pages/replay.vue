<script setup lang="ts">
/**
 * The sandbox replay (docs/09 section 8).
 *
 * Nothing here counts, nothing is stored, and the opponent is a fixture. What it is for is
 * the thing docs/10 M6 gates on: watching a full game without reaching for the skip button.
 *
 * It renders through <MatchWatch>, which is the same component a duel's shared watch uses.
 * The difference between the two is entirely the clock — this page owns one and drives it
 * from requestAnimationFrame, with a scrub bar and speeds, because a sandbox is for poking
 * at. A duel's clock comes from the duel row and cannot be moved by either player, because
 * two people watching the same match is exactly the thing a movable clock breaks.
 *
 * Default speed is 60×, per docs/09: the whole game in about half a minute with the ticker
 * still readable, easing down to 8× for a few seconds around each big moment. Skip to result is always visible, because forcing somebody to watch is how
 * you teach them to skip forever.
 */

const data = ref<any>(null);
const loading = ref(true);
const error = ref('');
const clock = ref(0);
const transport = ref<any>(null);

const result = computed(() => data.value?.result ?? null);
const length = computed(() => matchEnd(result.value));

/**
 * The result, once it has been seen, stays. Showing it only while the clock sat at the end
 * meant that jumping to a key moment from the result list hid the list you had just used.
 */
const resultShown = ref(false);
watch([clock, length], ([t, end]) => {
  if (end && t >= end) resultShown.value = true;
});

async function load(seed?: string) {
  loading.value = true;
  transport.value?.pause();
  try {
    data.value = await $fetch<any>('/api/sim/run', { query: seed ? { seed } : {} });
    clock.value = 0;
    resultShown.value = false;
    error.value = '';
  } catch (e: any) {
    error.value = e?.statusMessage || e?.data?.statusMessage || 'Could not run a match.';
  } finally {
    loading.value = false;
  }
}

/** A key moment in the result was picked: go there and play from it. */
function seek(t: number) {
  resultShown.value = true;
  clock.value = t;
  nextTick(() => transport.value?.play());
}

onMounted(() => load());

useHead({ title: 'Replay — LOM' });
</script>

<template>
  <main class="page page--wide">
    <header class="topbar">
      <h1>Replay</h1>
      <span v-if="data" class="topbar__meta tnum">Seed {{ data.seed }}</span>
    </header>

    <p v-if="error" class="notice notice--bad" role="alert">{{ error }}</p>

    <!-- Shaped like what is coming: the scoreboard strip, then the map at the art's own
         2000 by 1670 aspect, with the ticker column beside it on a wide screen. -->
    <div v-if="loading" class="replay-skeleton" aria-hidden="true">
      <div class="skeleton replay-skeleton__board" />
      <div class="replay-skeleton__stage">
        <div class="skeleton replay-skeleton__map" />
        <div class="skeleton replay-skeleton__ticker" />
      </div>
    </div>

    <template v-else-if="result">
      <p v-if="data.source === 'FIXTURE' && data.missing.length" class="notice">
        Fielding a stand-in team: yours is missing
        {{ data.missing.join(', ') }}. <NuxtLink to="/roster">Fill it</NuxtLink> and the
        next match runs with your cards.
      </p>

      <MatchWatch
        :result="result"
        :clock="clock"
        :blue-name="data.blueName"
        :red-name="data.redName"
        :show-result="resultShown || clock >= length"
        seekable
        @seek="seek"
      >
        <template #controls>
          <ReplayTransport
            ref="transport"
            :key="data.seed"
            v-model:clock="clock"
            :length="length"
            autoplay
          />
        </template>
      </MatchWatch>

      <div class="again">
        <button class="btn btn--ghost" type="button" @click="load()">Run another match</button>
        <NuxtLink class="btn" to="/duels">Battle someone instead</NuxtLink>
      </div>
    </template>
  </main>
</template>

<style scoped>
.replay-skeleton { display: grid; gap: 12px; }
.replay-skeleton__board { height: 64px; }
.replay-skeleton__stage { display: grid; gap: 12px; }
.replay-skeleton__map { aspect-ratio: 2000 / 1670; }
.replay-skeleton__ticker { height: 120px; }
@media (min-width: 820px) {
  .replay-skeleton__stage { grid-template-columns: minmax(0, 1fr) 300px; align-items: start; }
  .replay-skeleton__ticker { height: 100%; min-height: 240px; }
}


.again {
  margin-top: 24px;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: center;
}
</style>
