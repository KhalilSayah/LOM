-- =============================================================================
-- 0017 — Collection showcase and collection summaries
--
-- Forward-only and re-runnable. Run in the Supabase SQL editor, or:
--   supabase db push
--
-- Needs 0001 (collection_cards, card_definitions). Nothing else.
--
-- Two parts:
--
--   1. `collection_cards.is_favourite` — a manager stars up to three cards, and those
--      three are what a friend sees first: at the top of /m/<code> and on the
--      discovery list, instead of the "Best" line. Written only by the server
--      (/api/discovery/showcase); there is still no client write policy on
--      collection_cards, and this migration does not add one. A trigger holds the
--      cap of three, so a race between two taps cannot make it four.
--
--   2. `collection_summaries(ids)` — card count, rarity tally, headline card and
--      showcase for several managers, grouped in Postgres. The discovery list used to
--      pull every collection row of every manager on it in one unpaged query and count
--      them in JavaScript, which PostgREST silently cuts at 1000 rows: a list of four
--      active managers already showed wrong totals. Now it is one row per manager.
--
--      SECURITY INVOKER on purpose. The server calls it with the service-role key,
--      which reads every row; a signed-in client calling it through PostgREST is
--      still filtered by the collection_cards RLS policy and sees only its own
--      numbers. Nothing here is readable that was not readable before.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Favourites
-- -----------------------------------------------------------------------------

alter table collection_cards
  add column if not exists is_favourite boolean not null default false;

comment on column collection_cards.is_favourite is
  'Starred by its owner. Up to three per manager; shown to anyone with their share code. Written by the server only.';

create index if not exists collection_cards_favourite_idx
  on collection_cards (profile_id) where is_favourite;

create or replace function public.collection_cards_favourite_cap()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.is_favourite and (tg_op = 'INSERT' or not coalesce(old.is_favourite, false)) then
    if (
      select count(*) from collection_cards c
      where c.profile_id = new.profile_id and c.is_favourite and c.id <> new.id
    ) >= 3 then
      raise exception 'A showcase holds three cards.' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists collection_cards_favourite_cap on collection_cards;
create trigger collection_cards_favourite_cap
  before insert or update of is_favourite on collection_cards
  for each row execute function public.collection_cards_favourite_cap();

-- -----------------------------------------------------------------------------
-- 2. Summaries, grouped
--
-- `best` is the rarest card, then the highest rated: the one they would show you
-- if they had not chosen. `showcase` is what they did choose, rarest first.
-- -----------------------------------------------------------------------------

create or replace function public.collection_summaries(p_ids uuid[])
returns table (profile_id uuid, total int, bands jsonb, best jsonb, showcase jsonb)
language sql
stable
security invoker
set search_path = public
as $$
  with owned as (
    select cc.profile_id, cc.id, cc.is_favourite,
           cd.card_key, cd.player_name, cd.season, cd.ovr, cd.rarity, cd.role, cd.team,
           coalesce(array_position(array['COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'ICON'], cd.rarity), 0) as band
    from collection_cards cc
    join card_definitions cd on cd.id = cc.card_definition_id
    where cc.profile_id = any(p_ids)
  ),
  per_manager as (
    select o.profile_id as pid, count(*)::int as n
    from owned o
    group by o.profile_id
  ),
  per_band as (
    select x.pid, jsonb_object_agg(x.rarity, x.n) as tally
    from (
      select o.profile_id as pid, o.rarity, count(*)::int as n
      from owned o
      group by o.profile_id, o.rarity
    ) x
    group by x.pid
  ),
  headline as (
    select distinct on (o.profile_id) o.profile_id as pid,
           jsonb_build_object(
             'playerName', o.player_name, 'season', o.season,
             'ovr', o.ovr, 'rarity', o.rarity
           ) as card
    from owned o
    order by o.profile_id, o.band desc, o.ovr desc, o.player_name
  ),
  starred as (
    select s.pid,
           jsonb_agg(jsonb_build_object(
             'id', s.id, 'cardKey', s.card_key, 'playerName', s.player_name,
             'season', s.season, 'ovr', s.ovr, 'rarity', s.rarity,
             'role', s.role, 'team', s.team
           ) order by s.band desc, s.ovr desc) as cards
    from (
      select o.profile_id as pid, o.*,
             row_number() over (partition by o.profile_id order by o.band desc, o.ovr desc) as rn
      from owned o
      where o.is_favourite
    ) s
    where s.rn <= 3
    group by s.pid
  )
  select m.pid, m.n, coalesce(b.tally, '{}'::jsonb), h.card, coalesce(s.cards, '[]'::jsonb)
  from per_manager m
  left join per_band b on b.pid = m.pid
  left join headline h on h.pid = m.pid
  left join starred s on s.pid = m.pid;
$$;

revoke all on function public.collection_summaries(uuid[]) from public, anon;
grant execute on function public.collection_summaries(uuid[]) to authenticated, service_role;
