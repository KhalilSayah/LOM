/**
 * The signed-in manager's id, client side.
 *
 * @nuxtjs/supabase 2.x fills `useSupabaseUser()` from `auth.getClaims()`, so the value is
 * a decoded JWT rather than a User row: the id is `sub` and there is no `id` field at all.
 * Reading `.id` gives undefined, PostgREST serialises that into the query as the literal
 * string "undefined", and Postgres rejects it as an invalid uuid — an error that names the
 * database but is really about the shape of this object.
 *
 * Same fix as requireManager() on the server, and the same reason for keeping it in one
 * place: every screen that reads a collection needs it, and getting it wrong fails loudly
 * but confusingly.
 */
export function useManagerId() {
  const user = useSupabaseUser();
  return computed<string | null>(() => {
    const claims = user.value as Record<string, any> | null;
    return claims?.sub || claims?.id || null;
  });
}
