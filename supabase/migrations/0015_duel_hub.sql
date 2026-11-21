-- =============================================================================
-- 0015 — Duel rooms that hold up: a real heartbeat, one room at a time,
--        challenges that expire, practice difficulty, and a secret seed
--
-- Forward-only and re-runnable. Run in the Supabase SQL editor, or:
--   supabase db push
--
-- Six things, each fixing something that went wrong in play.
--
--   1. duel_queue.last_seen_at. The heartbeat upsert never touched joined_at (on
--      purpose: it is queue order) and staleness was measured from joined_at, so every
--      searcher was swept as a ghost ninety seconds in. joined_at keeps the order;
--      last_seen_at decides whether anybody is still behind the row.
--   2. duels.difficulty, for practice against the agent (Easy / Normal / Hard).
--   3. At most one pending challenge between two managers, in either direction, and
--      none older than a day.
--   4. At most one practice draft per manager, so a double tap cannot open two.
--   5. duel_matchmake skips anybody already in a live room, refreshes last_seen_at,
--      and judges staleness by it.
--   6. Clients can no longer read duels.seed. The seed decides the agent's picks and
--      the whole match; anyone holding it before the draft knows how it ends.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The heartbeat
-- -----------------------------------------------------------------------------

alter table duel_queue add column if not exists last_seen_at timestamptz not null default now();

comment on column duel_queue.last_seen_at is
  'Refreshed by every heartbeat (duel_matchmake). Staleness is judged from this; '
  'joined_at is only queue order and is never moved by a heartbeat.';

create index if not exists duel_queue_seen_idx
  on duel_queue (last_seen_at)
  where duel_id is null;

-- -----------------------------------------------------------------------------
-- 2. Practice difficulty
-- -----------------------------------------------------------------------------

alter table duels add column if not exists difficulty text;

do $difficulty$
begin
  alter table duels add constraint duels_difficulty_check
    check (difficulty is null or difficulty in ('EASY', 'NORMAL', 'HARD'));
exception when duplicate_object then null;
end $difficulty$;

comment on column duels.difficulty is
  'Practice only: how hard the agent plays (server/utils/duel.ts AGENT_PROFILES). Null means '
  'NORMAL. Nothing about a practice duel counts anywhere.';

-- 0006 added this and 0007 stopped writing it. It is written again now: the player's own
-- selection, honoured when the clock runs out. Re-stated so the dependency is visible.
alter table duels add column if not exists hover jsonb;

-- -----------------------------------------------------------------------------
-- 3. Challenges: one pending between two people, and only for a day
-- -----------------------------------------------------------------------------

-- Anything already older than a day has expired. Written off as CANCELLED: to both
-- people an expired challenge and a withdrawn one are the same thing.
update duels
set status = 'CANCELLED', updated_at = now()
where status = 'PENDING'
  and created_at < now() - interval '24 hours';

-- A->B and B->A both pending was possible, each waiting on the other. Keep the older
-- one of any such pair so the index below can be built.
with ranked as (
  select id,
         row_number() over (
           partition by least(challenger_id, opponent_id), greatest(challenger_id, opponent_id)
           order by created_at
         ) as n
  from duels
  where status = 'PENDING' and opponent_id is not null
)
update duels
set status = 'CANCELLED', updated_at = now()
where id in (select id from ranked where n > 1);

create unique index if not exists duels_one_pending_between
  on duels (least(challenger_id, opponent_id), greatest(challenger_id, opponent_id))
  where status = 'PENDING';

-- -----------------------------------------------------------------------------
-- 4. One practice draft per manager
--
-- The bot route checks for a live room and then inserts; two taps fall into that gap.
-- A bot duel has the player as challenger, so this index is the whole guarantee.
-- -----------------------------------------------------------------------------

with ranked as (
  select id,
         row_number() over (partition by challenger_id order by created_at desc) as n
  from duels
  where status = 'DRAFTING' and source = 'BOT'
)
update duels
set status = 'CANCELLED', updated_at = now()
where id in (select id from ranked where n > 1);

create unique index if not exists duels_one_bot_draft_per_player
  on duels (challenger_id)
  where status = 'DRAFTING' and source = 'BOT';

-- -----------------------------------------------------------------------------
-- 5. Pairing
-- -----------------------------------------------------------------------------

-- Is this manager in a room that still needs them: a draft, or a match still playing?
-- The match ends at its last event, not at result.gameLength — the engine stamps the
-- Baron and the nexus up to a minute past it (shared/duelRoom.ts matchEnd).
create or replace function public.duel_in_live_room(p_profile uuid)
returns boolean
language sql
stable
set search_path = public
as $fn$
  select exists (
    select 1
    from duels d
    where (d.challenger_id = p_profile or d.opponent_id = p_profile)
      and (
        d.status = 'DRAFTING'
        or (
          d.status = 'WATCHING'
          and (
            d.watch_start_at is null
            or d.result is null
            or d.watch_start_at + make_interval(secs => (
                 greatest(
                   coalesce((d.result->>'gameLength')::double precision, 0),
                   coalesce((d.result->'events'->-1->>'t')::double precision, 0)
                 ) / greatest(coalesce(d.watch_speed, 60), 1)
               )) > now()
          )
        )
      )
  );
$fn$;

revoke all on function public.duel_in_live_room(uuid) from public;
revoke all on function public.duel_in_live_room(uuid) from anon, authenticated;

create or replace function public.duel_matchmake(
  p_profile     uuid,
  p_lineup      jsonb,
  p_catalogue   uuid,
  p_lobby_secs  int default 4,
  p_action_secs int default 30,
  p_bonus_secs  int default 60,
  p_stale_secs  int default 90
)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  mine    duel_queue;
  partner duel_queue;
  new_id  uuid;
  blue    uuid;
  red     uuid;
  starts  timestamptz;
begin
  -- Join, or refresh a heartbeat. joined_at is left alone so queue position stays
  -- first-come; last_seen_at is what says this searcher is still here.
  insert into duel_queue (profile_id, lineup, last_seen_at)
  values (p_profile, p_lineup, now())
  on conflict (profile_id) do update
    set lineup = excluded.lineup,
        last_seen_at = now()
  returning * into mine;

  -- Already paired, by somebody else's call, possibly milliseconds ago.
  if mine.duel_id is not null then
    return mine.duel_id;
  end if;

  -- In a room already: not searching, whatever the client thinks. The join route checks
  -- this first; this is the backstop for the race.
  if public.duel_in_live_room(p_profile) then
    return null;
  end if;

  select * into partner
  from duel_queue q
  where q.profile_id <> p_profile
    and q.duel_id is null
    and q.last_seen_at > now() - make_interval(secs => p_stale_secs)
    -- Somebody who accepted a friendly while their queue row was still up is in a room;
    -- pairing them would put them in two.
    and not public.duel_in_live_room(q.profile_id)
  order by q.joined_at
  limit 1
  for update skip locked;

  if partner.profile_id is null then
    return null;
  end if;

  -- Sides are drawn, not awarded.
  if random() < 0.5 then
    blue := p_profile;
    red := partner.profile_id;
  else
    blue := partner.profile_id;
    red := p_profile;
  end if;

  starts := now() + make_interval(secs => p_lobby_secs);

  insert into duels (
    challenger_id, opponent_id, status, source,
    blue_id, red_id, blue_lineup, red_lineup,
    catalogue_version_id, seed,
    turn, bonus, starts_at, deadline_at, accepted_at
  ) values (
    p_profile, partner.profile_id, 'DRAFTING', 'QUEUE',
    blue, red,
    case when blue = p_profile then p_lineup else partner.lineup end,
    case when red  = p_profile then p_lineup else partner.lineup end,
    -- gen_random_uuid() draws from pg_strong_random: unpredictable, and never readable by a
    -- client (section 6).
    p_catalogue,
    'duel-' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
    0, jsonb_build_object('BLUE', p_bonus_secs, 'RED', p_bonus_secs),
    starts,
    -- The lobby is inside the first action's clock, so nobody's first ban is short.
    starts + make_interval(secs => p_action_secs),
    now()
  )
  returning id into new_id;

  -- Both rows point at the duel; this update is the partner's notification.
  update duel_queue
  set duel_id = new_id, matched_at = now()
  where profile_id in (p_profile, partner.profile_id);

  return new_id;
end;
$fn$;

revoke all on function public.duel_matchmake(uuid, jsonb, uuid, int, int, int, int) from public;
revoke all on function public.duel_matchmake(uuid, jsonb, uuid, int, int, int, int) from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 6. The seed is the server's
--
-- RLS let a participant `select *` their own duels, seed included. The seed drives the
-- agent's every choice and the simulation, so reading it before the draft is reading the
-- result. Postgres has no "every column but one" grant, so the table-level SELECT is
-- revoked and every other column is granted back by name — done in a loop so this stays
-- right whatever columns exist when it runs.
--
-- Consequence for clients: `select('*')` on duels as a signed-in user now fails with a
-- permission error. Name the columns, or go through a server route (service role is
-- unaffected). No client code reads duels directly today; the realtime subscriptions only
-- use the push as a cue to resync, and Realtime leaves out columns the subscriber cannot
-- select. A column added by a later migration must be granted to `authenticated` by name
-- if a client is ever meant to read it.
--
-- To undo: grant select on public.duels to authenticated;
-- -----------------------------------------------------------------------------

revoke select on table public.duels from anon;
revoke select on table public.duels from authenticated;

do $grants$
declare
  col record;
begin
  for col in
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'duels'
      and column_name <> 'seed'
  loop
    execute format('grant select (%I) on public.duels to authenticated', col.column_name);
  end loop;
end $grants$;

revoke select (seed) on public.duels from anon;
revoke select (seed) on public.duels from authenticated;
