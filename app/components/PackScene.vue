<script setup lang="ts">
import { createPack } from '@lom/card-engine';

const props = defineProps<{ card: Record<string, any>; label?: string; autoOpen?: boolean }>();
const emit = defineEmits<{ (e: 'revealed'): void; (e: 'kept'): void; (e: 'phase', phase: string): void }>();

const host = ref<HTMLElement | null>(null);
let pack: any = null;
let autoTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Auto-open waits for the scene to say it is armed, rather than guessing a delay.
 *
 * The scene arms itself two animation frames after it is built, and animation frames do not
 * run in a background tab while timers still do. A fixed timer could therefore fire first,
 * find the pack not yet armed, do nothing, and leave the reveal waiting for a tap nobody was
 * told to make. Opening off the `armed` phase cannot lose that race.
 */
onMounted(() => {
  if (!host.value) return;
  pack = createPack(props.card, {
    label: props.label || 'Daily pack',
    onPhase: (phase: string) => {
      emit('phase', phase);
      if (phase === 'armed' && props.autoOpen) {
        clearTimeout(autoTimer);
        autoTimer = setTimeout(() => pack?.open(), 260);
      }
    },
    onReveal: () => emit('revealed'),
    onKeep: () => emit('kept'),
  });
  host.value.appendChild(pack.el);
});

onBeforeUnmount(() => {
  clearTimeout(autoTimer);
  pack?.destroy?.();
});

defineExpose({ open: () => pack?.open() });
</script>

<template>
  <div ref="host" class="pack-host" />
</template>

<style scoped>
.pack-host :deep(.lom-pack-scene) { min-height: 100svh; }
/* The scene ships its own "Open another" button; in the app a pack is once a day. */
.pack-host :deep([data-act='again']) { display: none; }
</style>
