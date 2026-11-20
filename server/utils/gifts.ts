/**
 * Gifted packs.
 *
 * A gift is an entitlement: a row in `pack_gifts` saying this manager may open one pack of
 * a given type for nothing. The cards are not chosen when the gift is granted — they are
 * rolled when it is opened, through the same path a bought pack takes, so a gift handed out
 * in March still pays out against the catalogue that is live when it is opened.
 *
 * An unopened row is also the notification. There is no separate "you have mail" table,
 * because a notification that can disagree with the thing it announces eventually does.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** The reason key for the pack every account gets. Unique per manager, so granting twice is a no-op. */
export const WELCOME_REASON = 'WELCOME';

export interface GiftRow {
  id: string;
  pack_type: string;
  reason: string;
  title: string;
  body: string | null;
  granted_at: string;
  seen_at: string | null;
  pack_types?: { name: string; slots: number; one_per_role: boolean } | null;
}

export const GIFT_SELECT =
  'id, pack_type, reason, title, body, granted_at, seen_at, pack_types ( name, slots, one_per_role )';

/** What the client is told about a waiting gift. */
export function toGift(row: GiftRow) {
  return {
    id: row.id,
    packType: row.pack_type,
    packName: row.pack_types?.name ?? row.pack_type,
    slots: row.pack_types?.slots ?? 1,
    onePerRole: row.pack_types?.one_per_role ?? false,
    reason: row.reason,
    title: row.title,
    body: row.body,
    grantedAt: row.granted_at,
    seen: Boolean(row.seen_at),
  };
}

/**
 * Give this manager the welcome pack if they do not already have it.
 *
 * Normally the signup trigger has done this before the account can even sign in. This is
 * the heal path, for an account that existed before migration 0008 and has no profile row
 * either, and it mirrors `ensureProfile`: the gift is granted the first time the server
 * sees the manager rather than never.
 *
 * Never throws. A missing welcome pack is worth a log line, not a failed request — the
 * caller is usually in the middle of something the manager actually asked for.
 */
export async function ensureWelcomePack(db: SupabaseClient, profileId: string): Promise<void> {
  const { error } = await db.rpc('grant_welcome_pack', { p_profile: profileId });
  if (error) {
    console.warn(`[gifts] welcome pack for ${profileId} not granted: ${error.message}`);
  }
}
