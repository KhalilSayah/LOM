import { fileURLToPath } from 'node:url';

// The card engine lives in packages/ as plain ES modules with JSDoc types, so Vite can
// consume it directly — no build step, no workspace linking, no Vercel root-directory
// gymnastics. docs/06-architecture.md keeps it a separate package so apps/web and the
// future sim share one renderer.
const cardEngine = fileURLToPath(new URL('./packages/card-engine/src/index.js', import.meta.url));

// Same arrangement for the rules and the match engine: plain ESM with JSDoc types, so
// Nitro imports them directly and `node` runs the tuning harnesses with no build step.
const core = fileURLToPath(new URL('./packages/core/src/index.js', import.meta.url));
const sim = fileURLToPath(new URL('./packages/sim/src/index.js', import.meta.url));

export default defineNuxtConfig({
  compatibilityDate: '2025-11-01',
  devtools: { enabled: false },
  modules: ['@nuxtjs/supabase'],

  alias: { '@lom/card-engine': cardEngine, '@lom/core': core, '@lom/sim': sim },

  css: [
    '~/assets/css/main.css',
    '~~/packages/card-engine/src/card.css',
    '~~/packages/card-engine/src/pack.css',
  ],

  // We do our own redirecting in middleware/auth.ts, because the pack screen is the
  // landing page for a signed-in manager and the module's default sends everyone to /login.
  supabase: {
    redirect: false,
    // No generated database types checked in yet; the module warns otherwise.
    types: false,
  },

  runtimeConfig: {
    // Server only. Overridden by NUXT_PACK_HOUR / NUXT_PACK_TZ in the host environment.
    // The client never computes the window — /api/pack/status hands it an instant.
    packHour: '17',
    packTz: 'Europe/Paris',
  },

  nitro: {
    preset: process.env.VERCEL ? 'vercel' : undefined,
  },

  experimental: {
    /**
     * Reload the moment a lazy chunk fails to load, rather than waiting for the router.
     *
     * Every deploy rotates the hashes in /_nuxt, so anyone with the app already open is
     * holding a page that references chunks the new deployment does not serve. The next
     * navigation asks for one, the browser refuses it, and Nuxt's default error page shows
     * what looks like a server fault: a 500, with "Failed to fetch dynamically imported
     * module" inside it. Nothing is wrong, the app is simply one version stale, and a reload
     * fixes it — which is why it is maddening to debug and why it is reported as a bug in
     * whatever screen the person happened to click.
     *
     * Nuxt's default here is 'automatic', which recovers only when the failure surfaces as a
     * router error. When it surfaces anywhere else the error page wins. 'automatic-immediate'
     * reloads on the preload failure itself, which is the case that actually bites.
     *
     * This is the right fix rather than a workaround: there is no version of a deployed SPA
     * where an open tab keeps working across a deploy, so the only question is whether the
     * person sees a reload or a stack trace.
     */
    emitRouteChunkError: 'automatic-immediate',
  },

  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
        { name: 'theme-color', content: '#05080e' },
        { name: 'description', content: 'Collect player-season cards from pro League of Legends. One pack a day.' },
      ],
      link: [
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        {
          rel: 'stylesheet',
          href: 'https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=Barlow:wght@400;500;600;700&family=Barlow+Condensed:wght@500;600;700&display=swap',
        },
      ],
    },
  },

  typescript: { typeCheck: false },
});
