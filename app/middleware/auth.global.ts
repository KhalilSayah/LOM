/**
 * Signed out, every route is the door. Signed in, the door is the pack.
 * The pack screen is the landing page, which is why @nuxtjs/supabase's own redirect
 * handling is switched off in nuxt.config.ts.
 *
 * Where you were going is carried through the door as `?next=`. Without it an invite
 * link — the one URL in this app that is sent to people who have no account yet —
 * would land a new manager on the pack screen with no sign of the league they were
 * invited to. `safeNext` is what stops that query parameter becoming an open
 * redirect. The door also reads `next` to say who invited you, and to give link-preview
 * bots (which are always signed out) a title worth showing.
 *
 * A few pages are open to anyone: the door, the confirm and password-reset landings
 * (both arrive from an email, before there is a session), and How to play, which the
 * door links to. A path that matches no page at all is let through as well, so a broken
 * link shows the 404 rather than a sign-in screen that then leads to one.
 */
const PUBLIC = new Set(['/', '/confirm', '/reset', '/how-to-play']);

export default defineNuxtRouteMiddleware((to) => {
  const user = useSupabaseUser();

  if (!to.matched.length) return;

  if (!user.value && !PUBLIC.has(to.path)) {
    return navigateTo({ path: '/', query: { next: to.fullPath } });
  }
  if (user.value && to.path === '/') {
    return navigateTo(safeNext(to.query.next));
  }
});
