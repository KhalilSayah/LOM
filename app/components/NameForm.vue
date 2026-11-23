<script setup lang="ts">
import { normaliseHandle, handleProblem, HANDLE_MAX, DISPLAY_MAX, TEAM_MAX } from '~~/shared/names';

/**
 * The three names a manager plays under, edited in one place: the step after sign-up and
 * the Name section of Settings both use this form. It saves through /api/profile/name,
 * because profiles cannot be written from the client.
 *
 * The handle is checked as it is typed — shape locally, availability against the server
 * after a short pause — so "taken" is said before the button is pressed.
 */

const props = withDefaults(defineProps<{
  handle?: string;
  displayName?: string;
  teamName?: string | null;
  submitLabel?: string;
  /** Prefix for element ids, so two forms on one page would not collide. */
  idPrefix?: string;
}>(), { handle: '', displayName: '', teamName: '', submitLabel: 'Save', idPrefix: 'name' });

const emit = defineEmits<{ saved: [profile: any] }>();

const handle = ref(props.handle);
const displayName = ref(props.displayName === props.handle ? '' : props.displayName);
const teamName = ref(props.teamName || '');

watch(() => [props.handle, props.displayName, props.teamName], () => {
  handle.value = props.handle;
  displayName.value = props.displayName === props.handle ? '' : props.displayName;
  teamName.value = props.teamName || '';
});

const busy = ref(false);
const error = ref('');
const saved = ref(false);

const clean = computed(() => normaliseHandle(handle.value));
const unchanged = computed(() => !!props.handle && clean.value === props.handle);
const shapeProblem = computed(() => (clean.value && !unchanged.value ? handleProblem(clean.value) : null));

/** Server answer for the handle currently typed: null while unknown. */
const availability = ref<{ handle: string; available: boolean; reason: string | null } | null>(null);
let checkTimer: ReturnType<typeof setTimeout> | undefined;

watch(clean, (h) => {
  clearTimeout(checkTimer);
  saved.value = false;
  if (!h || unchanged.value || handleProblem(h)) { availability.value = null; return; }
  checkTimer = setTimeout(async () => {
    try {
      const res = await $fetch<{ handle: string; available: boolean; reason: string | null }>(
        '/api/profile/handle', { query: { h } },
      );
      if (res.handle === clean.value) availability.value = res;
    } catch {
      availability.value = null; // The save will say if it is taken.
    }
  }, 350);
});
onBeforeUnmount(() => clearTimeout(checkTimer));

const handleNote = computed(() => {
  if (!clean.value) return `3 to ${HANDLE_MAX} letters, numbers or underscores. This is how people find you.`;
  if (unchanged.value) return 'Your current name.';
  if (shapeProblem.value) return shapeProblem.value;
  if (availability.value?.handle === clean.value) {
    return availability.value.available ? 'Free. It is yours if you want it.' : availability.value.reason || 'Somebody already has that name.';
  }
  return 'Checking…';
});
const handleBad = computed(() => !!shapeProblem.value
  || (availability.value?.handle === clean.value && !availability.value.available));

async function submit() {
  error.value = '';
  saved.value = false;
  const problem = unchanged.value ? null : handleProblem(clean.value);
  if (problem) { error.value = problem; return; }
  busy.value = true;
  try {
    const res = await $fetch<{ profile: any }>('/api/profile/name', {
      method: 'POST',
      body: { handle: clean.value, displayName: displayName.value, teamName: teamName.value },
    });
    saved.value = true;
    playSound('success');
    emit('saved', res.profile);
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.statusMessage || 'Your name could not be saved. Try again.';
    playSound('error');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="nameform" novalidate @submit.prevent="submit">
    <div class="field">
      <label :for="`${idPrefix}-handle`">Name</label>
      <div class="nameform__at">
        <span aria-hidden="true">@</span>
        <input
          :id="`${idPrefix}-handle`" v-model="handle" type="text" inputmode="text"
          autocomplete="username" autocapitalize="none" spellcheck="false"
          :maxlength="HANDLE_MAX + 1" placeholder="baron_hunter" required
          :aria-invalid="handleBad ? 'true' : undefined"
          :aria-describedby="`${idPrefix}-handle-note`"
        >
      </div>
      <p :id="`${idPrefix}-handle-note`" class="nameform__note" :class="{ 'is-bad': handleBad }" aria-live="polite">{{ handleNote }}</p>
    </div>

    <div class="field">
      <label :for="`${idPrefix}-display`">Display name <span class="faint">(optional)</span></label>
      <input
        :id="`${idPrefix}-display`" v-model="displayName" type="text" autocomplete="nickname"
        :maxlength="DISPLAY_MAX" :placeholder="clean || 'Same as your name'"
      >
    </div>

    <div class="field">
      <label :for="`${idPrefix}-team`">Team name <span class="faint">(optional)</span></label>
      <input
        :id="`${idPrefix}-team`" v-model="teamName" type="text" autocomplete="off"
        :maxlength="TEAM_MAX" :placeholder="displayName || clean || 'Your display name'"
        :aria-describedby="`${idPrefix}-team-note`"
      >
      <p :id="`${idPrefix}-team-note`" class="nameform__note">What a new league seat is called. You can still rename it per league.</p>
    </div>

    <div role="alert" aria-live="assertive">
      <p v-if="error" class="notice notice--bad">{{ error }}</p>
    </div>
    <p v-if="saved" class="nameform__ok" role="status">Saved.</p>

    <div class="nameform__actions">
      <button class="btn btn--block" type="submit" :disabled="busy || handleBad || !clean" data-sound="none">
        {{ busy ? 'Saving' : submitLabel }}
      </button>
      <slot name="secondary" />
    </div>
  </form>
</template>

<style scoped>
.nameform { display: grid; gap: 16px; }
.nameform__at { position: relative; }
.nameform__at > span {
  position: absolute; left: 14px; top: 50%; transform: translateY(-50%);
  color: var(--ink-3); font-weight: 650; pointer-events: none;
}
.nameform__at input { padding-left: 30px; }
.nameform__note { margin: 0; font-size: 12.5px; line-height: 1.45; color: var(--ink-3); }
.nameform__note.is-bad { color: var(--red-2); }
.nameform__ok { margin: 0; font-size: 13px; color: var(--teal-1); }
.nameform__actions { display: grid; gap: 10px; }
.field .faint { font-weight: 500; }
</style>
