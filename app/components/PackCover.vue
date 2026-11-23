<script setup lang="ts">
import { packCover, COVER_SIZE } from '@lom/card-engine';

/** A sealed pack as a picture: the same foil and art the opening uses. */
const props = defineProps<{ kind: string }>();

const canvas = ref<HTMLCanvasElement | null>(null);
let stop: (() => void) | undefined;

function listen() {
  stop?.();
  stop = packCover(props.kind, (cover: HTMLCanvasElement) => {
    const x = canvas.value?.getContext('2d');
    if (!x) return;
    x.clearRect(0, 0, COVER_SIZE.w, COVER_SIZE.h);
    x.drawImage(cover, 0, 0);
  });
}

onMounted(listen);
watch(() => props.kind, listen);
onBeforeUnmount(() => stop?.());
</script>

<template>
  <canvas ref="canvas" class="pack-cover" :width="COVER_SIZE.w" :height="COVER_SIZE.h" aria-hidden="true" />
</template>

<style scoped>
.pack-cover { display: block; width: 100%; height: 100%; }
</style>
