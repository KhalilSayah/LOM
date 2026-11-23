/**
 * Leaving an account, properly.
 *
 * The chrome's signals (wallet, duel badge, gifts) start once per tab behind useState flags
 * and keep their own timers and listeners, so a plain `signOut()` followed by a route change
 * leaves the previous manager's credits, challenges and gifts sitting in memory — and their
 * poll still running — for whoever signs in next on the same tab.
 *
 * So leaving is a hard reset: every piece of Nuxt state is cleared and the app is reloaded
 * from the server, which kills every interval and listener with the old page. The next
 * account starts from nothing, the way a fresh tab would.
 */

let leaving = false;

/** Clears all app state and reloads the app at `path`. Safe to call more than once. */
export function resetApp(path = '/') {
  if (leaving || import.meta.server) return;
  leaving = true;
  try { clearNuxtState(); } catch { /* the reload below is what really matters */ }
  reloadNuxtApp({ path, persistState: false, force: true });
}

export function useSignOut() {
  const supabase = useSupabaseClient();

  return async function signOut(path = '/') {
    try {
      const { error } = await supabase.auth.signOut();
      // A failed network call leaves the session in place; forget it locally regardless,
      // or the reload would land straight back in the same account.
      if (error) await supabase.auth.signOut({ scope: 'local' });
    } catch {
      try { await supabase.auth.signOut({ scope: 'local' }); } catch { /* reload anyway */ }
    }
    resetApp(path);
  };
}
