<script setup lang="ts">
/**
 * The first four things to do, on Home, until they are done.
 *
 * Each step ticks off from the real thing (see /api/profile/checklist): the welcome pack
 * opened, five roster slots filled, a practice duel won, a league seat held. Nothing here
 * is a flag the client sets, so it cannot claim a step that has not happened, and an
 * account that did everything before this card existed never sees it.
 *
 * The next undone step is the only one with a button, so a brand-new account has exactly
 * one obvious thing to press: open the welcome pack. The card goes away by itself when
 * every step is done, and can be dismissed for good before that (per manager, per device).
 */
interface Checklist {
  steps: { welcome: boolean; five: boolean; practice: boolean; league: boolean };
  hasWelcomeGift: boolean;
  handle: string | null;
  handleChosen: boolean;
}

const managerId = useManagerId();
const { gifts } = useGiftSignal();

const data = ref<Checklist | null>(null);
const dismissed = ref(true); // until read from storage, so it never flashes in

const storeKey = computed(() => `lom-firstrun-dismissed:${managerId.value || ''}`);

async function load() {
  if (!managerId.value) return;
  try {
    data.value = await $fetch<Checklist>('/api/profile/checklist');
  } catch {
    data.value = null; // A checklist is not worth an error on Home.
  }
}

onMounted(() => {
  try { dismissed.value = window.localStorage.getItem(storeKey.value) === '1'; } catch { dismissed.value = false; }
  if (!dismissed.value) load();
});

// Opening the welcome pack happens in the shop; coming back, the gift list has changed.
watch(() => gifts.value.length, () => { if (!dismissed.value) load(); });

function dismiss() {
  dismissed.value = true;
  try { window.localStorage.setItem(storeKey.value, '1'); } catch { /* this visit only */ }
}

const STEPS = computed(() => {
  const s = data.value?.steps;
  if (!s) return [];
  return [
    { key: 'welcome', done: s.welcome, title: 'Open your welcome pack', hint: 'Free, and waiting for you in the shop.', to: '/shop', cta: 'Open it', gold: true },
    { key: 'five', done: s.five, title: 'Fill your five', hint: 'Top, jungle, mid, bot and support.', to: '/roster', cta: 'Pick them', gold: false },
    { key: 'practice', done: s.practice, title: 'Win a practice battle', hint: 'Draft against the agent. No stakes.', to: '/duels', cta: 'Play', gold: false },
    { key: 'league', done: s.league, title: 'Join or host a league', hint: 'A season with friends, one match an evening.', to: '/leagues', cta: 'Leagues', gold: false },
  ];
});

const doneCount = computed(() => STEPS.value.filter((s) => s.done).length);
const nextKey = computed(() => STEPS.value.find((s) => !s.done)?.key ?? null);
const needsName = computed(() => data.value ? !data.value.handleChosen : false);

const visible = computed(() => !dismissed.value && !!data.value && (doneCount.value < 4 || needsName.value));
</script>

<template>
  <section v-if="visible" class="firstrun" aria-labelledby="firstrun-title">
    <span class="firstrun__tl" aria-hidden="true" /><span class="firstrun__br" aria-hidden="true" />
    <header class="firstrun__head">
      <div>
        <h2 id="firstrun-title">Getting started</h2>
        <p class="faint firstrun__count"><span class="tnum">{{ doneCount }}</span> of 4 done · <NuxtLink to="/how-to-play">How to play</NuxtLink></p>
      </div>
      <button class="icon-btn" type="button" aria-label="Hide getting started" data-sound="back" @click="dismiss">
        <svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>
    </header>

    <div class="meter firstrun__meter" aria-hidden="true"><i :style="{ width: `${doneCount * 25}%` }" /></div>

    <p v-if="needsName" class="firstrun__name">
      <span>You are <b>@{{ data?.handle }}</b>, a name we picked.</span>
      <NuxtLink class="btn btn--quiet btn--sm" to="/settings#name">Choose yours</NuxtLink>
    </p>

    <ol class="firstrun__steps">
      <li v-for="(s, i) in STEPS" :key="s.key" class="frstep" :class="{ 'is-done': s.done, 'is-next': s.key === nextKey }">
        <span class="frstep__mark" aria-hidden="true">
          <svg v-if="s.done" viewBox="0 0 24 24" class="ico"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
          <template v-else>{{ i + 1 }}</template>
        </span>
        <span class="frstep__text">
          <b>{{ s.title }}</b>
          <span class="sr-only">{{ s.done ? ', done' : ', not done yet' }}</span>
          <small v-if="!s.done" class="faint">{{ s.hint }}</small>
        </span>
        <NuxtLink
          v-if="s.key === nextKey" class="btn btn--sm" :class="s.gold ? 'btn--gold' : 'btn--ghost'" :to="s.to"
        >{{ s.cta }}</NuxtLink>
        <NuxtLink v-else-if="!s.done" class="frstep__go" :to="s.to" :aria-label="s.title">
          <svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
        </NuxtLink>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.firstrun {
  position: relative;
  margin-bottom: 18px;
  padding: 14px 14px 10px;
  border: 1px solid var(--line-2);
  border-radius: var(--radius);
  background: linear-gradient(165deg, #121b2d, #0a0f19 70%);
}
.firstrun__tl, .firstrun__br { position: absolute; width: 12px; height: 12px; border: 1.5px solid var(--gold-2); pointer-events: none; }
.firstrun__tl { top: -1px; left: -1px; border-right: 0; border-bottom: 0; }
.firstrun__br { right: -1px; bottom: -1px; border-left: 0; border-top: 0; }

.firstrun__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.firstrun__head h2 { font-size: 20px; }
.firstrun__count { margin: 4px 0 0; font-size: 12.5px; }
.firstrun__count a { color: var(--ink-2); text-decoration: underline; text-decoration-color: var(--line-3); text-underline-offset: 3px; }
.firstrun__head .icon-btn { margin: -8px -8px 0 0; }
.firstrun__head .icon-btn svg { width: 18px; height: 18px; }
.firstrun__meter { margin: 10px 0 6px; }

.firstrun__name {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  margin: 8px 0 2px; padding: 8px 10px; border-radius: 2px; background: var(--bg-0);
  font-size: 13.5px; color: var(--ink-2);
}
.firstrun__name b { color: var(--ink-1); }

.firstrun__steps { list-style: none; margin: 0; padding: 0; }
.frstep { display: flex; align-items: center; gap: 12px; min-height: 56px; padding: 6px 0; }
.frstep + .frstep { border-top: 1px solid var(--line-1); }
.frstep__mark {
  display: grid; place-items: center; flex: none;
  width: 28px; height: 28px; border-radius: 50%;
  box-shadow: inset 0 0 0 1.5px var(--line-3);
  color: var(--ink-3); font-size: 12.5px; font-weight: 760; font-variant-numeric: tabular-nums;
}
.frstep__mark svg { width: 16px; height: 16px; stroke-width: 2.2; }
.frstep.is-next .frstep__mark { box-shadow: inset 0 0 0 1.5px var(--gold-2); color: var(--gold-1); }
.frstep.is-done .frstep__mark { background: var(--gold-2); box-shadow: none; color: var(--gold-ink); }
.frstep__text { flex: 1; min-width: 0; display: grid; gap: 1px; }
.frstep__text b { font-size: 14.5px; font-weight: 680; }
.frstep__text small { font-size: 12.5px; }
.frstep.is-done .frstep__text b { color: var(--ink-3); font-weight: 600; text-decoration: line-through; text-decoration-color: var(--line-3); }
.frstep .btn { flex: none; }
.frstep__go { display: grid; place-items: center; flex: none; width: 44px; height: 44px; color: var(--ink-3); }
.frstep__go svg { width: 18px; height: 18px; }
.frstep__go:hover { color: var(--ink-1); }
</style>
