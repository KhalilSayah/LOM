-- =============================================================================
-- 0007 — Duel rooms: matchmaking, a synchronised draft, a shared watch
--
-- Forward-only and re-runnable. Run in the Supabase SQL editor, or:
--   supabase db push
--
-- 0005 built a duel as correspondence chess: you challenged a named manager, they
-- accepted whenever they next opened the app, and the draft screen polled. That is a
-- fine way to settle a fixture and a poor way to spend an evening. What this migration
-- turns it into is a room: you press one button, you are put with whoever else pressed
-- it, and from that moment the two of you are looking at the same thing at the same
-- time until somebody has won.
--
-- Three things change, and they are the three reasons the old shape could not do it.
--
--   1. Nobody is named. A queue row says "I am here and this is my five"; pairing is a
--      function, not an invitation. The lineup travels with the queue row precisely so
--      that pairing can be one atomic statement — see duel_matchmake below.
--   2. The room has a clock of its own. starts_at gives both clients the same moment
--      to stop saying "match found" and start drafting, and watch_start_at gives them
--      the same moment to start watching. A shared experience needs a shared origin,
--      and the only honest place to keep one is here.
--   3. Nothing polls. These tables go into the realtime publication, so a write reaches
--      both clients as a push. Hover never touches the database at all any more — it is
--      a client-to-client broadcast, which is what 0006 wanted and could not have.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The duel grows a lobby, a watch, and the possibility of no opponent
-- -----------------------------------------------------------------------------

alter table duels drop constraint if exists duels_status_check;
alter table duels add constraint duels_status_check check (status in (
  'PENDING',    -- a named challenge, waiting to be answered (the friendly path)
  'DECLINED',
  'CANCELLED',
  'DRAFTING',   -- the room is live; starts_at may still be in the future
  'WATCHING',   -- 20 actions done, match simulated, both on the shared watch clock
  'COMPLETE'
));

-- A queue match has no invitation to accept, so there is no moment at which both
-- players are known to be looking. starts_at is that moment instead: the server sets
-- it a few seconds out, both clients show "match found" until it passes, and the first
-- action's deadline already has those seconds in it. Without it the first ban silently
-- loses however long the two of them took to load.
alter table duels add column if not exists starts_at timestamptz;

-- The shared watch. One timestamp, written once, and both clients render
-- (now - watch_start_at) * watch_speed seconds into the same match. There is no
-- play/pause and no scrub: a shared clock is the whole point, and the moment one side
-- can move it the two of them are watching different games.
alter table duels add column if not exists watch_start_at timestamptz;
alter table duels add column if not exists watch_speed int not null default 60;

do $watchspeed$
begin
  alter table duels add constraint duels_watch_speed_check
    check (watch_speed between 1 and 240);
exception when duplicate_object then null;
end $watchspeed$;

comment on column duels.watch_start_at is
  'Wall-clock origin of the shared watch. Authoritative: a client renders a clock from '
  'it and never decides where the match is up to.';

-- How the two of them found each other. Worth recording because a queue duel and a
-- friendly are the same game and should not be the same row in a leaderboard later.
alter table duels add column if not exists source text not null default 'CHALLENGE';

do $source$
begin
  alter table duels add constraint duels_source_check
    check (source in ('CHALLENGE', 'QUEUE', 'BOT'));
exception when duplicate_object then null;
end $source$;

-- Which side, if any, the auto-draft agent is playing on purpose rather than because
-- somebody walked away. On a bot duel opponent_id is null: a profile row requires an
-- auth.users row, and inventing a fake account to hold a fake roster would put the bot
-- in discovery, in the handle namespace, and in every count of how many people play.
alter table duels add column if not exists bot_side text;

do $botside$
begin
  alter table duels add constraint duels_bot_side_check
    check (bot_side in ('BLUE', 'RED'));
exception when duplicate_object then null;
end $botside$;

alter table duels alter column opponent_id drop not null;

-- duels_not_self compares two columns and is simply not evaluated when one is null,
-- so a bot duel passes it without the constraint being weakened for anyone else.

-- One live *challenge* in a given direction at a time. This used to cover DRAFTING as
-- well, which is wrong once pairing is a queue: the same two people will be put
-- together again, and the index would refuse the rematch — or worse, refuse it only
-- sometimes, depending on who the queue happened to name as challenger.
drop index if exists duels_one_live_per_pair;
create unique index if not exists duels_one_pending_per_pair
  on duels (challenger_id, opponent_id)
  where status = 'PENDING';

-- The live index is read whenever a room is brought up to date with its clock.
drop index if exists duels_live_idx;
create index if not exists duels_live_idx on duels (status, deadline_at)
  where status in ('DRAFTING', 'WATCHING');

-- -----------------------------------------------------------------------------
-- 2. The queue
--
-- One row per manager who is searching. The lineup snapshot lives on the row rather
-- than being read at pairing time, which is what lets duel_matchmake be a single
-- statement: by the time two rows meet, both fives are already frozen and the duel can
-- be created complete. Reading the rosters inside the pairing transaction instead would
-- mean holding a lock across two collection scans, and would reintroduce the thing
-- 0005 was careful about — a card changing under somebody between agreeing to play and
-- playing.
-- -----------------------------------------------------------------------------

create table if not exists duel_queue (
  profile_id uuid primary key references profiles(id) on delete cascade,
  joined_at  timestamptz not null default now(),
  -- Frozen at join. See above.
  lineup     jsonb not null,
  -- Null while searching; set by duel_matchmake, which is how the side that did not do
  -- the pairing finds out it has been paired.
  duel_id    uuid references duels(id) on delete set null,
  matched_at timestamptz
);

comment on table duel_queue is
  'Managers currently searching for a duel. A row is a claim on being here now, not a '
  'record: stale rows are ignored by duel_matchmake and swept by the join route.';

create index if not exists duel_queue_waiting_idx
  on duel_queue (joined_at)
  where duel_id is null;

-- -----------------------------------------------------------------------------
-- 3. Pairing
--
-- The hard part is that two people press the button in the same instant. Both see an
-- empty queue containing only the other, both pair, and two duels exist for one match —
-- or one of them pairs with a row the other is already consuming.
--
-- `for update skip locked` is the whole answer. Whichever transaction reaches a waiting
-- row first owns it; the other does not block and does not see it, finds nothing, and
-- returns having been paired by the winner — which it discovers by reading its own row,
-- the first thing this function does.
--
-- security definer because the caller is the service role today, but the function is
-- written so it would also be safe called as the player: it only ever pairs p_profile.
-- -----------------------------------------------------------------------------

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
  -- Join, or refresh a heartbeat. The upsert deliberately does not touch joined_at when
  -- the row already exists: queue position is first-come, and a client that re-posts
  -- while searching should not send itself to the back.
  insert into duel_queue (profile_id, lineup)
  values (p_profile, p_lineup)
  on conflict (profile_id) do update
    set lineup = excluded.lineup
  returning * into mine;

  -- Already paired, by somebody else's call, possibly milliseconds ago.
  if mine.duel_id is not null then
    return mine.duel_id;
  end if;

  select * into partner
  from duel_queue
  where profile_id <> p_profile
    and duel_id is null
    and joined_at > now() - make_interval(secs => p_stale_secs)
  order by joined_at
  limit 1
  for update skip locked;

  if partner.profile_id is null then
    return null;
  end if;

  -- Sides are drawn, not awarded. Blue has first ban and first pick, red has last pick,
  -- and the person who happened to press the button second has not earned either.
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
    p_catalogue, 'duel-' || gen_random_uuid()::text,
    0, jsonb_build_object('BLUE', p_bonus_secs, 'RED', p_bonus_secs),
    starts,
    -- The lobby is inside the first action's clock, so nobody's first ban is short.
    starts + make_interval(secs => p_action_secs),
    now()
  )
  returning id into new_id;

  -- Both rows point at the duel. The partner is not listening to this transaction, so
  -- this update *is* the notification: realtime pushes it to their open queue
  -- subscription and their client follows the id into the room.
  update duel_queue
  set duel_id = new_id, matched_at = now()
  where profile_id in (p_profile, partner.profile_id);

  return new_id;
end;
$fn$;

revoke all on function public.duel_matchmake(uuid, jsonb, uuid, int, int, int, int) from public;

-- -----------------------------------------------------------------------------
-- 4. Row-level security
--
-- Unchanged in spirit: a participant reads their own rows and the server is the only
-- writer. The queue gets the same treatment, which also means the realtime push that
-- tells somebody they have been paired cannot be seen by anyone else.
-- -----------------------------------------------------------------------------

alter table duel_queue enable row level security;

drop policy if exists duel_queue_select_own on duel_queue;
create policy duel_queue_select_own on duel_queue
  for select using (profile_id = auth.uid());

-- A bot duel has a null opponent_id, so the 0005 policy — which reads
-- "challenger or opponent is me" — already covers it correctly. Stated here because it
-- is the kind of thing that looks like an oversight on a later read.

-- -----------------------------------------------------------------------------
-- 5. Realtime
--
-- This is the migration's point. With these tables in the publication, a write by a
-- Nitro route arrives at both clients as a push, and the 700 ms poll on the draft
-- screen goes away — along with the reason duels.hover had to be a column at all.
--
-- `replica identity full` so an update carries its old row: the draft screen animates
-- what changed, and a changed-columns diff is only available when the old tuple is in
-- the WAL.
-- -----------------------------------------------------------------------------

alter table duels      replica identity full;
alter table duel_queue replica identity full;

do $publication$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table duels;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table duel_actions;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table duel_queue;
    exception when duplicate_object then null;
    end;
  end if;
end $publication$;

-- duels.hover is left in place and no longer written. Hover is a broadcast on the room
-- channel now: it never needed to be durable, and a column overwritten several times a
-- second to hold something nobody will ever read again was always the wrong home for
-- it. Dropping it is a separate migration, once no deployed client reads it.
