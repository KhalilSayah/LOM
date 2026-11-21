<script setup lang="ts">
import type { NuxtError } from '#app';

/**
 * The page for a route that does not exist, and for anything that fell over.
 *
 * Rendered outside the layout, so it carries its own mark and its own way out. It never
 * shows the error's message for a server fault: that text is written for whoever reads
 * the logs, and a player can do nothing with "Cannot read properties of undefined".
 * The way out goes to Home when signed in and to the door when not, and clears the error
 * on the way, so the app underneath starts clean.
 */
const props = defineProps<{ error: NuxtError }>();
const user = useSupabaseUser();

const status = computed(() => Number(props.error?.statusCode) || 500);
const missing = computed(() => status.value === 404);
const offline = computed(() => import.meta.client && typeof navigator !== 'undefined' && navigator.onLine === false);

const title = computed(() => {
  if (missing.value) return 'This page is not in the deck';
  if (offline.value) return 'You are offline';
  return 'Something went wrong';
});
const line = computed(() => {
  if (missing.value) return 'The link may be old, or mistyped. Nothing is wrong with your account.';
  if (offline.value) return 'LOM needs a connection. Check yours, then try again.';
  return 'That one is on us, not you. Try again, and if it keeps happening, come back in a few minutes.';
});

const home = computed(() => (user.value ? '/pack' : '/'));
function goHome() { clearError({ redirect: home.value }); }
function retry() {
  if (import.meta.client) window.location.reload();
}

useHead({ title: `${missing.value ? 'Not found' : 'Error'} — LOM` });
</script>

<template>
  <main class="err">
    <a class="err__logo logo" href="/" @click.prevent="goHome">
      <svg viewBox="0 0 28 28" aria-hidden="true"><path d="M14 2l12 12-12 12L2 14z" fill="none" stroke="#d8b064" stroke-width="1.6" /><path d="M14 7.5L20.5 14 14 20.5 7.5 14z" fill="#d8b064" /></svg>
      <b>LOM</b>
    </a>

    <div class="err__card">
      <span class="err__tl" aria-hidden="true" /><span class="err__br" aria-hidden="true" />
      <p class="err__code num" aria-hidden="true">{{ status }}</p>
      <h1>{{ title }}</h1>
      <p class="muted err__line">{{ line }}</p>
      <div class="err__actions">
        <button class="btn btn--lg" type="button" @click="goHome">Back to Home</button>
        <button v-if="!missing" class="btn btn--quiet" type="button" @click="retry">Try again</button>
      </div>
    </div>
  </main>
</template>

<style scoped>
.err {
  min-height: 100svh;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 28px;
  padding: max(24px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom));
  text-align: center;
}
.err__logo { min-height: 44px; }
.err__card {
  position: relative;
  width: 100%;
  max-width: 440px;
  padding: 34px 22px 26px;
  border: 1px solid var(--line-1);
  border-radius: var(--radius);
  background: linear-gradient(165deg, #121b2d, #0a0f19 70%);
}
.err__tl, .err__br { position: absolute; width: 14px; height: 14px; border: 1.5px solid var(--gold-2); pointer-events: none; }
.err__tl { top: -1px; left: -1px; border-right: 0; border-bottom: 0; }
.err__br { right: -1px; bottom: -1px; border-left: 0; border-top: 0; }
.err__code { margin: 0 0 8px; font-size: 64px; color: var(--gold-2); }
.err h1 { font-size: clamp(26px, 7vw, 34px); }
.err__line { margin: 12px auto 22px; max-width: 36ch; font-size: 14.5px; line-height: 1.55; }
.err__actions { display: grid; gap: 10px; }
</style>
