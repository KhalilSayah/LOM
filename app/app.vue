<script setup lang="ts">
/**
 * Site-wide head: the share card every page falls back to.
 *
 * og:image has to be an absolute URL, and the deployment's origin is only known at request
 * time (preview deployments each have their own), so it is built from the request here
 * rather than written into nuxt.config.ts. Pages override the title and description; the
 * door does so for invite and collection links, which is what a group chat's preview shows.
 */
const url = useRequestURL();
const image = `${url.origin}/og-image.png`;

useSeoMeta({
  ogSiteName: 'LOM',
  ogType: 'website',
  ogTitle: 'LOM — League of Managers',
  ogDescription: 'Collect real player-seasons from pro League of Legends. One pack a day, a five to field, friends to draft against.',
  ogImage: image,
  ogImageWidth: 1200,
  ogImageHeight: 630,
  ogImageAlt: 'The LOM diamond mark on a navy stage',
  twitterCard: 'summary_large_image',
  twitterImage: image,
});

/**
 * The service worker only ever serves an offline page when a navigation fails; it never
 * caches HTML or /_nuxt, so it cannot hold a deploy back (public/sw.js). Registered in
 * production only — in dev it would just get in the way of hot reload.
 */
onMounted(() => {
  if (import.meta.dev || !('serviceWorker' in navigator)) return;
  const register = () => navigator.serviceWorker.register('/sw.js').catch(() => {});
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
});
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
