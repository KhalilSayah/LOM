<script setup lang="ts">
import { formatShareCode } from '~~/shared/shareCode';

/**
 * A manager's own share code, with the two ways anyone actually passes one on: read
 * it out, or send a link. Both buttons write to the clipboard and say so for a
 * moment, because a copy button that looks identical before and after leaves people
 * pressing it twice.
 */

const props = defineProps<{ code: string | null; handle?: string | null }>();

const pretty = computed(() => formatShareCode(props.code) || '————————');

const link = computed(() => {
  if (!props.code) return '';
  const origin = import.meta.client ? window.location.origin : '';
  return `${origin}/m/${props.code}`;
});

const flash = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;

async function copy(what: 'code' | 'link') {
  const text = what === 'code' ? pretty.value : link.value;
  if (!props.code || !text) return;

  try {
    await navigator.clipboard.writeText(text);
    flash.value = what === 'code' ? 'Code copied' : 'Link copied';
  } catch {
    // Clipboard access is refused on insecure origins and in some in-app browsers.
    // The code is on screen in full, so this is a dead end, not a failure.
    flash.value = 'Copy it by hand — it is right there.';
  }

  clearTimeout(timer);
  timer = setTimeout(() => { flash.value = ''; }, 2400);
}

onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <section class="panel share">
    <p class="eyebrow">Your code</p>
    <p class="share__code tnum">{{ pretty }}</p>
    <p class="muted share__note">
      Hand this to anyone. They put it into Discovery and your collection opens up.
    </p>
    <div class="share__row">
      <button class="btn btn--quiet" type="button" :disabled="!code" @click="copy('code')">
        Copy code
      </button>
      <button class="btn btn--quiet" type="button" :disabled="!code" @click="copy('link')">
        Copy link
      </button>
    </div>
    <p v-if="flash" class="share__flash" role="status">{{ flash }}</p>
  </section>
</template>

<style scoped>
.share__code {
  font-family: var(--font-display);
  font-size: 32px;
  font-weight: 700;
  letter-spacing: 0.1em;
  margin: 6px 0 0;
  color: var(--accent);
}
.share__note { font-size: 13.5px; line-height: 1.55; margin: 8px 0 0; }
.share__row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.share__flash {
  font-family: var(--font-label);
  font-size: 13px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--accent);
  margin: 10px 0 0;
}
@media (max-width: 380px) {
  .share__code { font-size: 27px; }
}
</style>
