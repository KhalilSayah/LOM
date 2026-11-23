<script setup lang="ts">
import { createCard } from '@lom/card-engine';

/**
 * One card, rendered by @lom/card-engine into a host element after mount.
 *
 * The host reserves the card's 63:88 shape before anything is built, so a page full of
 * cards does not render as a column of zero-height boxes and then jump once each one
 * mounts. `lite` (default: compact and not interactive) builds the grid-tile version with
 * no back face and no foil layers; see createCard() in the engine.
 */
const props = withDefaults(defineProps<{
  card: Record<string, any>;
  compact?: boolean;
  interactive?: boolean;
  lite?: boolean | null;
}>(), { compact: false, interactive: true, lite: null });

const host = ref<HTMLElement | null>(null);
let built: any = null;

function render() {
  if (!host.value || !props.card) return;
  built?.controller?.destroy?.();
  host.value.replaceChildren();
  built = createCard(props.card, {
    compact: props.compact,
    interactive: props.interactive,
    lite: props.lite ?? undefined,
  });
  host.value.appendChild(built.stage);
}

onMounted(render);
watch(() => [props.card?.cardKey, props.compact, props.interactive, props.lite], render);
onBeforeUnmount(() => built?.controller?.destroy?.());
</script>

<template>
  <div ref="host" class="lom-card-host" />
</template>

<style scoped>
/* The card's own shape, held before the card exists. */
.lom-card-host { aspect-ratio: 63 / 88; }
</style>
