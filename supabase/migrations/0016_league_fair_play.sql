-- =============================================================================
-- 0016 — Leagues that play fair and never stall
--
-- Forward-only and re-runnable. Run in the Supabase SQL editor, or:
--   supabase db push
--
-- **Run after 0009, 0010, 0013 and 0014.** It adds columns to `league_fixtures`
-- (0009, extended by 0010/0013/0014) and replaces the membership cap trigger 0009
-- created. Nothing here depends on 0011, 0012 or 0015.
--
-- Five things a league could not do honestly before:
--
--   1. A Ghost always drafted red, so a bye was always a free first pick. The
--      schedule now alternates the Ghost's side, and the row says which it took.
--   2. A fixture remembers whether either side was fielded with stand-ins (a manager
--      without a full five no longer blocks the fixture for ever) and whether the
--      agent played it for both because nobody opened it within a day of kick-off.
--   3. Both managers can say they are ready before kick-off, and the draft starts
--      when they both are instead of making two people stare at a countdown.
--   4. The six-manager cap is enforced under a lock. 0009's trigger counted and then
--      inserted, which two people tapping the same invite link pass together.
--   5. Joining a league that has just started is refused by the database, which is
--      the only place that sees the launch and the join in the same order.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Which side the Ghost drafts from
--
-- 0009 and 0013 both require a Ghost fixture's one manager to be in
-- `blue_member_id`, and loosening that would be a migration that touches every
-- existing season to buy a cosmetic. So the manager stays where they are and this
-- column says which side of the draft the Ghost actually takes. 'RED' — the manager
-- drafts first — is what every Ghost fixture already played was, so it is the
-- default and nothing needs backfilling.
-- -----------------------------------------------------------------------------

alter table league_fixtures add column if not exists ghost_side text;

do $ghost$
begin
  if not exists (select 1 from pg_constraint where conname = 'league_fixtures_ghost_side_check') then
    alter table league_fixtures add constraint league_fixtures_ghost_side_check
      check (ghost_side is null or (stage = 'GHOST' and ghost_side in ('BLUE', 'RED')));
  end if;
end $ghost$;

comment on column league_fixtures.ghost_side is
  'GHOST fixtures only: the side the Ghost drafts from. The manager is in blue_member_id either way; null reads as RED.';

-- -----------------------------------------------------------------------------
-- 2. How the fixture was played
--
-- `stand_ins` is `{ "BLUE": ["MID"], "RED": [] }`: the slots that were filled from
-- the catalogue because the manager had nothing in them when the room opened. Kept
-- on the fixture, not only on the duel's lineup snapshot, so the calendar can say so
-- without reading two lineups per row.
--
-- `auto_played_at` is set when nobody opened the fixture by kick-off + 24 hours and
-- the agent drafted both sides (docs/01 section 8: standings cannot be held hostage).
-- -----------------------------------------------------------------------------

alter table league_fixtures add column if not exists stand_ins jsonb;
alter table league_fixtures add column if not exists auto_played_at timestamptz;

comment on column league_fixtures.stand_ins is
  'Roster slots fielded with a catalogue stand-in because the manager had left them empty: {"BLUE": [...], "RED": [...]}.';
comment on column league_fixtures.auto_played_at is
  'Set when nobody opened the fixture within a day of kick-off and the agent played both sides.';

-- -----------------------------------------------------------------------------
-- 3. Ready before kick-off
--
-- The room opens fifteen minutes early but the draft waits for kick-off, so the
-- first manager in cannot start the clock on somebody still on their way. When both
-- have said they are ready, the draft starts straight away instead. Per side rather
-- than per profile because a fixture's sides are what the room is built from.
-- -----------------------------------------------------------------------------

alter table league_fixtures add column if not exists blue_ready_at timestamptz;
alter table league_fixtures add column if not exists red_ready_at timestamptz;

-- The lazy catch-up on a league read looks for these: fixtures nobody has opened
-- whose kick-off is long gone, and fixtures stuck PLAYING.
create index if not exists league_fixtures_catchup_idx
  on league_fixtures (league_id, season, status)
  where status in ('SCHEDULED', 'PLAYING');

-- -----------------------------------------------------------------------------
-- 4 and 5. The membership cap, under a lock, and only while forming
--
-- `for update` on the league row is the lock. Every insert into one league's
-- membership takes it first, so concurrent joins queue up behind each other and
-- each one counts the members the previous one committed. It is the same row the
-- launch route flips to ACTIVE, which is what makes the join/launch race come out
-- one way or the other rather than both: a join that gets the lock first is in the
-- launch's member list (the route reads members after its flip), and a join that
-- gets it second sees ACTIVE and is refused.
--
-- The owner's own membership is inserted by the create route while the league is
-- FORMING, so it passes.
-- -----------------------------------------------------------------------------

create or replace function public.league_members_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
  league_status text;
begin
  select status into league_status from leagues where id = new.league_id for update;

  if league_status is null then
    raise exception 'league_missing' using errcode = 'foreign_key_violation';
  end if;

  if league_status <> 'FORMING' then
    raise exception 'league_closed' using errcode = 'check_violation';
  end if;

  select count(*) into n from league_members where league_id = new.league_id;
  if n >= 6 then
    raise exception 'league_full' using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists league_members_cap_check on league_members;
create trigger league_members_cap_check
  before insert on league_members
  for each row execute function public.league_members_cap();
