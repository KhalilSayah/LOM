-- =============================================================================
-- 0013 — Playoffs, a champion, and the season placings
--
-- Forward-only and re-runnable. Run in the Supabase SQL editor, or:
--   supabase db push
--
-- **Run after 0009 and 0010**, which are the only migrations this one's DDL depends on:
-- it alters `league_fixtures` and `leagues`, and it calls `public.is_league_member` in a
-- policy. It does *not* depend on 0011 or 0012, so it can be applied before or after
-- them. At run time the payout calls `grant_credits` from 0004, which every database
-- that has a shop already has.
--
-- 0009 generated a double round robin and gave `leagues.status` a 'FINISHED' value
-- that nothing ever set. 0010 made a fixture playable. 0011 paid a match. What was
-- missing was the end: docs/01 section 3 draws a bracket on days 12-14, docs/01
-- section 7 records a champion and pays the placings, and none of it existed — so
-- the last row of the reward table in docs/01 section 5 (1500 / 900 / 500 / 250 for
-- 1st / 2nd / 3rd-4th / else) was the one faucet still specified and unwired, which
-- docs/12 section 7 said in so many words.
--
-- This migration is three things:
--
--   1. Two more fixture stages, so a semi-final and a final are rows on the same
--      calendar and play through the same duel room as everything else.
--   2. A champion on the league, and the honours board's first entry.
--   3. `season_rewards`, the ledger for the placings — one row per manager per
--      season, the same idempotency shape as `match_rewards` (0011) and
--      `pack_claims` (0004), for the same reason: a league that settles twice must
--      pay once.
--
-- The bracket itself is not SQL. It is shared/playoffs.ts, seeded from the final
-- table that shared/standings.ts computes, because a bracket is the second thing a
-- league argues about and an argument is settled by something you can read and test
-- rather than by an ORDER BY nobody can see. This file is only the shape it is
-- stored in.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Two more stages
--
-- 'GRAND_FINAL' rather than 'FINAL' on purpose. `status` already has a 'FINAL'
-- meaning "this match has been decided", and a stage called FINAL beside it would
-- make every read of either column a guess about which one was meant — in SQL, in
-- the API shaping, and on the screen.
-- -----------------------------------------------------------------------------

do $stage$
begin
  alter table league_fixtures drop constraint if exists league_fixtures_stage_check;
  alter table league_fixtures add constraint league_fixtures_stage_check
    check (stage in ('REGULAR', 'GHOST', 'REST', 'SEMI', 'GRAND_FINAL'));
end $stage$;

comment on column league_fixtures.stage is
  'REGULAR a round-robin fixture, GHOST the bye in an odd league, REST a rest day, SEMI and GRAND_FINAL the playoff bracket (docs/01 section 3).';

-- -----------------------------------------------------------------------------
-- 2. A playoff fixture may be waiting on its sides
--
-- 0009 said it plainly: a rest day has no sides, anything else has at least a blue
-- one. That was true of everything on the calendar at launch, because the schedule
-- knew every pairing in advance. A final does not: its two sides are the winners of
-- two semis that have not been played.
--
-- The alternative was to create the final only once both semis were decided, which
-- keeps the old constraint honest and costs the thing the bracket is *for* — a
-- fixture row with a date on it that everybody can see coming for three days. So
-- the constraint is relaxed for the two playoff stages only, and nothing else gains
-- the right to a missing side. openFixture() refuses to open a playoff fixture whose
-- sides are not both known; without that check it would read a null red side as a
-- Ghost and hand the final to the agent.
-- -----------------------------------------------------------------------------

do $sides$
begin
  alter table league_fixtures drop constraint if exists league_fixtures_rest_has_no_sides;
  alter table league_fixtures add constraint league_fixtures_sides_by_stage
    check (
      case stage
        when 'REST'    then blue_member_id is null and red_member_id is null
        -- As strong as the constraint it replaces, and no stronger. A REGULAR fixture
        -- always has a red side in practice (buildFixtures makes the unpaired one a
        -- GHOST), but tightening that here would be a migration that fails on somebody's
        -- existing data to buy an invariant the generator already keeps.
        when 'REGULAR' then blue_member_id is not null
        when 'GHOST'   then blue_member_id is not null and red_member_id is null
        -- A semi always knows both sides at generation; a final fills them in as the
        -- semis resolve. Both are allowed to be pending so one branch covers both.
        else true
      end
    );
end $sides$;

-- Which slot of the bracket this row is: 'SF1' (seeds 1v4), 'SF2' (2v3) or 'FINAL'.
--
-- Written rather than derived. A final whose sides are still pending cannot be
-- recognised by who is in it, and matching a semi back to its slot by re-deriving the
-- seeding would make every read of the bracket depend on the standings coming out the
-- same way twice. The row says what it is.
alter table league_fixtures add column if not exists bracket_key text;

do $bracket$
begin
  if not exists (select 1 from pg_constraint where conname = 'league_fixtures_bracket_key_check') then
    alter table league_fixtures add constraint league_fixtures_bracket_key_check
      check (
        (bracket_key is null) = (stage not in ('SEMI', 'GRAND_FINAL'))
        and (bracket_key is null or bracket_key in ('SF1', 'SF2', 'FINAL'))
      );
  end if;
end $bracket$;

-- One row per slot per league, and the whole bracket is inserted in a single
-- statement — so this is what makes a second generation fail whole rather than draw
-- the bracket twice. Two managers finishing the last regular fixture within the same
-- second both try, and the loser's insert is rejected entirely.
--
-- Per league, not per season: starting a second season in the same league (docs/01
-- section 7 point 4) is unbuilt, and when it is built it has to decide what happens to
-- the old season's fixture rows — which collide on day_index long before they collide
-- here.
create unique index if not exists league_fixtures_bracket_slot
  on league_fixtures (league_id, bracket_key)
  where bracket_key is not null;

-- -----------------------------------------------------------------------------
-- 3. The champion, and which season it was won in
--
-- `season` exists so the payout lock below can be per-season rather than per-league.
-- docs/01 section 7 point 4 says the owner can start a new season in the same league
-- with the collections kept; a `unique (league_id, profile_id)` would pay the first
-- season and silently swallow every one after it. Starting season 2 is still
-- unbuilt — this is the column it will increment, and defaulting it to 1 means
-- every league already has an answer.
-- -----------------------------------------------------------------------------

alter table leagues add column if not exists season int not null default 1;
alter table leagues add column if not exists champion_member_id uuid
  references league_members(id) on delete set null;

do $season$
begin
  if not exists (select 1 from pg_constraint where conname = 'leagues_season_positive') then
    alter table leagues add constraint leagues_season_positive check (season >= 1);
  end if;
end $season$;

comment on column leagues.champion_member_id is
  'Who won the grand final. Set at the same moment status becomes FINISHED; null before that.';
comment on column leagues.season is
  'Which season of this league is being played. The payout lock in season_rewards is per-season.';

-- -----------------------------------------------------------------------------
-- 4. The placings ledger
--
-- One row per manager per season, written *before* any Credits move, because that
-- row is the idempotency lock and not a record of a payment that already happened.
-- Same order and the same argument as payOne() in server/utils/rewards.ts: claim,
-- then money, then the receipt. There is no transaction to be had over PostgREST, so
-- the sequence is chosen for survivable failures — a crash after the claim pays
-- nothing twice, which is the failure worth being safe from.
--
-- `member_id` as well as `profile_id`: the placing belongs to a membership (it is
-- that team's finish, and a team name is per-league), the Credits belong to a
-- profile, and the lock has to be on the profile because that is who gets paid.
-- -----------------------------------------------------------------------------

create table if not exists season_rewards (
  id          uuid primary key default gen_random_uuid(),
  league_id   uuid not null references leagues(id) on delete cascade,
  season      int  not null default 1 check (season >= 1),

  member_id   uuid references league_members(id) on delete set null,
  profile_id  uuid not null references profiles(id) on delete cascade,

  -- 1 champion, 2 runner-up, 3 and 4 the beaten semi-finalists, then table order.
  --
  -- `place` and not `placing`, which is what the code calls it: PLACING is a reserved
  -- key word in Postgres (it is the separator in `overlay(string placing string from
  -- int)`), so a bare column of that name is a syntax error rather than a quoting
  -- inconvenience. The TypeScript side keeps `placing`; the mapping is one line in
  -- server/utils/seasonRewards.ts.
  place       int  not null check (place >= 1),
  credits     int  not null default 0 check (credits >= 0),

  -- The receipt: { label, place, teamName, champion }. The screen renders this
  -- rather than recomputing it, so what the manager reads is what the ledger paid.
  detail      jsonb not null default '{}'::jsonb,

  created_at  timestamptz not null default now(),

  unique (league_id, season, profile_id)
);

comment on table season_rewards is
  'One placing payout per manager per league season. The unique index is the idempotency lock: a season that settles twice pays once. docs/01 section 5, last row.';

create index if not exists season_rewards_profile_idx
  on season_rewards (profile_id, created_at desc);
create index if not exists season_rewards_league_idx
  on season_rewards (league_id, season, place);

-- -----------------------------------------------------------------------------
-- 5. Row-level security
--
-- Nobody writes. Settling a season holds the service-role key, which is the same
-- rule as match_rewards and for the same reason: a client that could insert a
-- season_rewards row could crown itself.
--
-- Reads are league-wide rather than own-row-only, which is the one place this
-- departs from match_rewards. A match payout is private because it contains the
-- manager's own grades and card XP. A placing contains a finishing position and
-- what docs/01 section 5 publicly says that position pays — both of which every
-- member can already read off the table — so hiding it would protect nothing and
-- would cost the honours board.
-- -----------------------------------------------------------------------------

alter table season_rewards enable row level security;

drop policy if exists season_rewards_select_league on season_rewards;
create policy season_rewards_select_league on season_rewards
  for select using (public.is_league_member(league_id) or profile_id = auth.uid());
