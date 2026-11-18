/**
 * Signed out, every route is the door. Signed in, the door is the pack.
 * The pack screen is the landing page, which is why @nuxtjs/supabase's own redirect
 * handling is switched off in nuxt.config.ts.
 */
export default defineNuxtRouteMiddleware((to) => {
  const user = useSupabaseUser();
  const isDoor = to.path === '/' || to.path === '/confirm';

  if (!user.value && !isDoor) return navigateTo('/');
  if (user.value && to.path === '/') return navigateTo('/pack');
});
