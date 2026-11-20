-- =============================================================================
-- 0010 — Playing a league fixture
--
-- Forward-only and re-runnable. Run after 0009_leagues.sql.
--
-- 0009 generated the calendar. This makes a row on it playable: a fixture opens a
-- duel room — the same draft and the same engine two friends already use (0005,
-- 0007) — and when the match is decided the fixture keeps the part of the result
-- the table needs.
--
-- Why the result is copied onto the fixture rather than read back out of
-- `duels.result`. That column is a whole match: twenty-odd minutes of events, a
-- timeline and a ten-row box score, tens of kilobytes of JSONB. A standings table
-- reads every finished fixture in the league at once, and doing that through the
-- event logs would mean fetching megabytes to count three numbers. So the three
-- numbers live here: who won, how long it took, and the kills. The duel stays the
-- record of what happened; this is the scoreboard.
--
-- docs/01 section 8 has a five-state fixture machine (lobby_open, drafting,
-- simulating, ready, final). This keeps the three states that are distinguishable
-- from outside — SCHEDULED, PLAYING, FINAL — because the draft's own states already
-- live on the duel, and a fixture status that mirrors them is a second opinion
-- waiting to disagree with the first.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. A duel can belong to a league fixture
-- -----------------------------------------------------------------------------

do $source$
begin
  alter table duels drop constraint if exists duels_source_check;
  alter table duels add constraint duels_source_check
    check (source in ('CHALLENGE', 'QUEUE', 'BOT', 'LEAGUE'));
end $source$;

comment on column duels.source is
  'CHALLENGE a friendly, QUEUE matchmaking, BOT the agent, LEAGUE a scheduled fixture.';

-- One fixture per duel. The write-back finds the fixture by the duel it came from,
-- and two fixtures claiming one duel would mean one match scoring twice.
create unique index if not exists league_fixtures_duel_key
  on league_fixtures (duel_id)
  where duel_id is not null;

-- -----------------------------------------------------------------------------
-- 2. The scoreboard
--
-- Written once, by the server, at the moment the match is decided — which is when
-- the draft's twentieth action resolves and the engine runs, not when somebody
-- finishes watching the replay. docs/01 section 8 is explicit that standings must
-- not be holdable hostage by a manager who refuses to open the app.
-- -----------------------------------------------------------------------------

alter table league_fixtures add column if not exists winner_side text;
alter table league_fixtures add column if not exists game_length int;
alter table league_fixtures add column if not exists blue_kills int;
alter table league_fixtures add column if not exists red_kills int;
alter table league_fixtures add column if not exists played_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'league_fixtures_winner_side_check') then
    alter table league_fixtures add constraint league_fixtures_winner_side_check
      check (winner_side is null or winner_side in ('BLUE', 'RED'));
  end if;
end;
$$;

comment on column league_fixtures.winner_side is
  'Which side won. On a GHOST fixture the Ghost has no member row, so this is the only record of it losing.';
comment on column league_fixtures.winner_member_id is
  'The winning member, or null when the Ghost won. docs/01 section 6: Ghost fixtures do not count toward the standings.';
comment on column league_fixtures.game_length is
  'Seconds. The standings tiebreak after head-to-head rewards closing a win quickly.';
