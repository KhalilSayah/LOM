/*
 * LOM service worker. Deliberately tiny.
 *
 * - Navigations go to the network, always. Only when the network fails does it answer,
 *   with /offline.html. HTML is never cached, so a deploy is never held back by a stale
 *   page, and nobody is ever shown another account's server-rendered screen.
 * - It caches the offline page and the icons it uses, and nothing else. /_nuxt, /api and
 *   Supabase requests are not touched at all.
 *
 * Bump VERSION to replace the cached shell. Old caches are deleted on activate.
 */
const VERSION = 'lom-shell-v1';
const SHELL = ['/offline.html', '/favicon.svg', '/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('lom-shell-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/offline.html').then((r) => r || Response.error())),
    );
    return;
  }

  const url = new URL(req.url);
  if (url.origin === self.location.origin && SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(req).then((r) => r || fetch(req)));
  }
});
