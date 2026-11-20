-- =============================================================================
-- 0008 — Gifted packs, and the notification that one is waiting
--
-- Forward-only and re-runnable. Run in the Supabase SQL editor, or:
--   supabase db push
--
-- Every manager gets a Signing pack on the house: five players, one per lane,
-- which is the shape docs/02 section 4 gives a starter squad and the pack
-- docs/02 section 5.1.1 calls "how a manager goes from nothing to a fieldable
-- squad in a single purchase". New accounts get it from the signup trigger;
-- accounts that already exist get it from the backfill in section 4.
--
-- A gift is an entitlement, not a grant of cards: the pack is rolled when the
-- manager opens it, against the catalogue active at that moment and through the
-- same roll a bought pack takes. So the gift row is also the notification — an
-- unopened one is what the nav dot and the call-out on the pack screen read.
--
-- The copy lives in the row rather than in the client, for the same reason pack
-- odds live in `pack_types`: handing out a different gift should be an INSERT in
-- the SQL editor, not a deploy.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The gifts
--
-- `reason` is the campaign key and is unique per manager, which is what makes
-- granting idempotent: the signup trigger and the backfill below can both run as
-- often as they like and nobody ends up with two welcome packs. A second round
-- of gifts is a new reason ('WELCOME_BACK', 'SEASON_2'), not a second 'WELCOME'.
-- -----------------------------------------------------------------------------

create table if not exists pack_gifts (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references profiles(id) on delete cascade,
  pack_type   text not null references pack_types(key),
  reason      text not null,
  title       text not null,
  body        text,
  granted_at  timestamptz not null default now(),
  seen_at     timestamptz,
  opened_at   timestamptz,
  opening_id  uuid references pack_openings(id) on delete set null,
  unique (profile_id, reason)
);

comment on table pack_gifts is
  'A pack a manager owns but has not rolled yet. An unopened row is the notification.';
comment on column pack_gifts.reason is
  'Campaign key, unique per manager. Granting the same reason twice is a no-op.';
comment on column pack_gifts.seen_at is
  'When the arrival was announced. The gift stays claimable; this only stops the nagging.';
comment on column pack_gifts.opened_at is
  'Set when the pack is rolled. Also the lock: two taps race on the update and one wins.';

-- The screens only ever ask for what is still waiting.
create index if not exists pack_gifts_waiting_idx
  on pack_gifts (profile_id, granted_at) where opened_at is null;

-- -----------------------------------------------------------------------------
-- 2. Granting
--
-- Same shape as grant_credits in 0004: one function that is the only supported
-- way in, and a by-handle twin, so handing someone a pack from the SQL editor
-- does not mean looking up a uuid first.
-- -----------------------------------------------------------------------------

/**
 * Give a manager a pack. Returns the new gift id, or null if they already have
 * a gift with this reason.
 *
 *   select grant_pack_gift_by_handle('khalil', 'LEGACY', 'APOLOGY', 'Sorry about the outage');
 */
create or replace function public.grant_pack_gift(
  p_profile uuid,
  p_pack    text,
  p_reason  text,
  p_title   text,
  p_body    text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  gift_id uuid;
begin
  insert into pack_gifts (profile_id, pack_type, reason, title, body)
  values (p_profile, p_pack, p_reason, p_title, p_body)
  on conflict (profile_id, reason) do nothing
  returning id into gift_id;

  return gift_id;
end;
$$;

create or replace function public.grant_pack_gift_by_handle(
  p_handle text,
  p_pack   text,
  p_reason text,
  p_title  text,
  p_body   text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  target uuid;
begin
  select id into target from profiles where handle = lower(p_handle);
  if target is null then
    raise exception 'grant_pack_gift_by_handle: no manager with handle %', p_handle;
  end if;
  return grant_pack_gift(target, p_pack, p_reason, p_title, p_body);
end;
$$;

/**
 * The welcome pack, in one place.
 *
 * The signup trigger, the backfill below and the server's profile-healing path
 * all call this, so there is exactly one copy of what a new manager is given and
 * exactly one copy of what the notification says.
 */
create or replace function public.grant_welcome_pack(p_profile uuid)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return grant_pack_gift(
    p_profile,
    'SIGNING',
    'WELCOME',
    'A Signing pack, on the house',
    'Five players, one for every lane — enough to field a squad on your first day. '
      || 'Free, and it does not touch today''s daily pack.'
  );
end;
$$;

-- Granting is an operator action, run as the service role or from the SQL
-- editor. No client ever calls these: one that could would gift itself a Legacy
-- pack every morning.
revoke execute on function public.grant_pack_gift(uuid, text, text, text, text) from anon, authenticated;
revoke execute on function public.grant_pack_gift_by_handle(text, text, text, text, text) from anon, authenticated;
revoke execute on function public.grant_welcome_pack(uuid) from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. New accounts
--
-- The same function as 0001, with the gift added. It runs inside the auth.users
-- insert, so a gift that cannot be written must not take the signup down with
-- it: the failure is a warning, and the server grants the pack on first use
-- instead (ensureProfile in server/utils/auth.ts).
-- -----------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  base_handle text;
  candidate   text;
  n           int := 0;
begin
  base_handle := lower(regexp_replace(split_part(new.email, '@', 1), '[^a-z0-9_]', '', 'g'));
  if length(base_handle) < 3 then
    base_handle := 'manager';
  end if;
  base_handle := left(base_handle, 16);

  candidate := base_handle;
  while exists (select 1 from profiles where handle = candidate) loop
    n := n + 1;
    candidate := left(base_handle, 16) || n::text;
  end loop;

  insert into profiles (id, handle, display_name)
  values (new.id, candidate, coalesce(new.raw_user_meta_data ->> 'display_name', candidate));

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

-- -----------------------------------------------------------------------------
-- 4. Accounts that already exist
--
-- Everyone who signed up before this migration ran. Idempotent through the
-- unique (profile_id, reason) index, so re-running this file costs one no-op
-- insert per manager and changes nothing.
--
-- An account with no profile row yet — one that predates 0001's trigger — is not
-- reachable from here and is handled by ensureProfile() on first use.
-- -----------------------------------------------------------------------------

do $$
begin
  perform grant_welcome_pack(id) from profiles;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Row-level security
--
-- A manager reads their own gifts and writes none of them. Opening one goes
-- through a Nitro route holding the service-role key, because a client that
-- could write `opened_at` could open the same gift twice — or clear it and open
-- it again tomorrow.
-- -----------------------------------------------------------------------------

alter table pack_gifts enable row level security;

drop policy if exists pack_gifts_select_own on pack_gifts;
create policy pack_gifts_select_own on pack_gifts
  for select to authenticated using (profile_id = auth.uid());
