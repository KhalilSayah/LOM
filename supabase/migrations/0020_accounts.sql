-- =============================================================================
-- 0020 — Accounts: a name you chose, not one read off your email
--
-- Until now the signup trigger built the handle from the email's local part, so
-- "jane.doe.1987@..." became the handle "janedoe1987" and was shown to everyone
-- the manager ever played. That is a privacy leak, and it is not a name anybody
-- picked.
--
-- This migration:
--   1. adds `handle_chosen`, which the door reads to decide whether to show the
--      "Choose your name" step after sign-up;
--   2. adds `team_name`, the default name a league seat is given (null means
--      "use the display name", which is what leagues already did);
--   3. replaces handle_new_user() so a new account starts with a neutral
--      placeholder handle (manager + six digits) instead of its email, keeping
--      the welcome pack grant from 0008 exactly as it was.
--
-- Existing accounts keep their handle and are marked not-chosen, so they can
-- rename themselves from Settings. Nothing else changes for them.
--
-- Profile edits go through /api/profile/name with the service-role key; this
-- migration grants nothing to the client.
--
-- Idempotent: safe to run more than once.
-- =============================================================================

alter table profiles add column if not exists handle_chosen boolean not null default false;

alter table profiles add column if not exists team_name text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_team_name_len' and conrelid = 'public.profiles'::regclass
  ) then
    alter table profiles
      add constraint profiles_team_name_len
      check (team_name is null or length(btrim(team_name)) between 1 and 24);
  end if;
end;
$$;

comment on column profiles.handle_chosen is
  'True once the manager has picked their own handle (the name step after sign-up, or Settings).';
comment on column profiles.team_name is
  'Default team name for a new league seat. Null means use display_name.';

-- -----------------------------------------------------------------------------
-- The signup trigger, without the email.
-- -----------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate text;
  tries     int := 0;
begin
  loop
    candidate := 'manager' || lpad((floor(random() * 1000000))::int::text, 6, '0');
    exit when not exists (select 1 from profiles where handle = candidate);
    tries := tries + 1;
    if tries > 20 then
      -- Practically unreachable; widen rather than loop forever.
      candidate := 'm' || replace(gen_random_uuid()::text, '-', '');
      candidate := left(candidate, 20);
      exit;
    end if;
  end loop;

  insert into profiles (id, handle, display_name)
  values (
    new.id,
    candidate,
    coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''), candidate)
  );

  begin
    perform public.grant_welcome_pack(new.id);
  exception when others then
    raise warning 'handle_new_user: welcome pack for % not granted: %', new.id, sqlerrm;
  end;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
