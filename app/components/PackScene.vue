<script setup lang="ts">
import { createPack } from '@lom/card-engine';

const props = defineProps<{ card: Record<string, any>; label?: string; autoOpen?: boolean }>();
const emit = defineEmits<{ (e: 'revealed'): void; (e: 'kept'): void; (e: 'phase', phase: string): void }>();

const host = ref<HTMLElement | null>(null);
let pack: any = null;

onMounted(() => {
  if (!host.value) return;
  pack = createPack(props.card, {
    label: props.label || 'Daily pack',
    onPhase: (phase: string) => emit('phase', phase),
    onReveal: () => emit('revealed'),
    onKeep: () => emit('kept'),
  });
  host.value.appendChild(pack.el);
  if (props.autoOpen) requestAnimationFrame(() => setTimeout(() => pack.open(), 260));
});

onBeforeUnmount(() => pack?.destroy?.());

defineExpose({ open: () => pack?.open() });
</script>

<template>
  <div ref="host" class="pack-host" />
</template>

<style scoped>
.pack-host :deep(.lom-pack-scene) { min-height: min(72vh, 560px); }
/* The scene ships its own "Open another" button; in the app a pack is once a day. */
.pack-host :deep([data-act='again']) { display: none; }
</style>
