<script setup lang="ts">
import { createCard } from '@lom/card-engine';

const props = withDefaults(defineProps<{
  card: Record<string, any>;
  compact?: boolean;
  interactive?: boolean;
}>(), { compact: false, interactive: true });

const host = ref<HTMLElement | null>(null);
let built: any = null;

function render() {
  if (!host.value) return;
  built?.controller?.destroy?.();
  host.value.replaceChildren();
  built = createCard(props.card, { compact: props.compact, interactive: props.interactive });
  host.value.appendChild(built.stage);
}

onMounted(render);
watch(() => props.card?.cardKey, render);
onBeforeUnmount(() => built?.controller?.destroy?.());
</script>

<template>
  <div ref="host" class="lom-card-host" />
</template>
