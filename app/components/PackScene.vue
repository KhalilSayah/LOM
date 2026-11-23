<script setup lang="ts">
import { createPack } from '@lom/card-engine';

/**
 * The pack opening, full screen. `cards` is one card or several; an entry may be
 * `{ card, note }` when the host has something to say under it ("Already yours: +250 XP").
 * `from` is where the pack is on screen right now, so it lifts off that spot.
 */
const props = defineProps<{
  cards: any;
  packType?: string;
  from?: { cx: number; cy: number; w: number } | null;
  keepLabel?: string;
}>();
const emit = defineEmits<{ (e: 'revealed', card: any): void; (e: 'kept'): void; (e: 'phase', phase: string): void }>();

const host = ref<HTMLElement | null>(null);
let pack: any = null;

onMounted(() => {
  if (!host.value) return;
  preloadPackSounds();
  pack = createPack(props.cards, {
    packType: props.packType || 'DAILY',
    from: props.from || undefined,
    keepLabel: props.keepLabel,
    onPhase: (phase: string) => emit('phase', phase),
    onCue: (name: string, detail?: any) => playPackCue(name, detail),
    onReveal: (card: any) => emit('revealed', card),
    onKeep: () => emit('kept'),
  });
  host.value.appendChild(pack.el);
});

onBeforeUnmount(() => pack?.destroy?.());

defineExpose({ open: () => pack?.open() });
</script>

<template>
  <div ref="host" class="pack-host" />
</template>
