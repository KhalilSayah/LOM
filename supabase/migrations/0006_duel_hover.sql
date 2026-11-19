-- =============================================================================
-- 0006 — What the drafting side is hovering
--
-- Forward-only and re-runnable.
--
-- docs/05 section 3.3 wants a hover broadcast to the opponent before an action is
-- locked, and calls it fire-and-forget. That holds when the transport is a realtime
-- channel; with polling there is nowhere to forget it to, and this app runs on
-- serverless functions where one request's memory is not the next request's memory.
-- So it is a column — one row, overwritten constantly, cleared whenever the turn
-- moves on.
--
-- It matters more than a nicety. Without it a draft only tells you anything at the
-- moment an action locks, so the other side stares at a still screen and a clock,
-- and every pick arrives as a surprise with no build-up. The hover is most of what
-- makes a draft feel live.
-- =============================================================================

alter table duels
  add column if not exists hover jsonb;

comment on column duels.hover is
  'Ephemeral: {side, kind, championKey, championName, slot, at}. Set by the side whose turn '
  'it is, cleared when the action locks or the turn changes. Never authoritative — the '
  'action log decides what actually happened.';
