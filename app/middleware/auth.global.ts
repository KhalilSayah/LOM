/**
 * Signed out, every route is the door. Signed in, the door is the pack.
 * The pack screen is the landing page, which is why @nuxtjs/supabase's own redirect
 * handling is switched off in nuxt.config.ts.
 *
 * Where you were going is carried through the door as `?next=`. Without it an invite
 * link — the one URL in this app that is sent to people who have no account yet —
 * would land a new manager on the pack screen with no sign of the league they were
 * invited to. `safeNext` is what stops that query parameter becoming an open
 * redirect.
 */
export default defineNuxtRouteMiddleware((to) => {
  const user = useSupabaseUser();
  const isDoor = to.path === '/' || to.path === '/confirm';

  if (!user.value && !isDoor) {
    return navigateTo({ path: '/', query: { next: to.fullPath } });
  }
  if (user.value && to.path === '/') {
    return navigateTo(safeNext(to.query.next));
  }
});
