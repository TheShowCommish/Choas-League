-- =====================================================================
-- 0021  Make league creation actually work under RLS
--
-- Creating a league was impossible for a normal signed-in user. Three
-- separate problems, all invisible to a superuser:
--
--   1. seed_commissioner_membership was not SECURITY DEFINER, so it ran
--      as the caller and was blocked by the league_members policy --
--      which requires you to already be the commissioner of the league
--      whose membership row you are trying to create. Chicken and egg.
--
--   2. seed_default_roster_slots had the same problem against
--      roster_slots.
--
--   3. Even with those fixed, `insert into leagues ... returning id`
--      applies the SELECT policy to the returned row, and leagues_read
--      asks is_league_member(id). AFTER-row triggers have not fired at
--      that point, so the membership does not exist yet and the read is
--      refused. The commissioner is now allowed to read their own league
--      directly, which is right regardless.
--
-- The definer triggers are safe: each only writes rows derived from the
-- league row that was just inserted, and the INSERT policy on leagues
-- has already established that commissioner_id is the caller.
-- =====================================================================

create or replace function public.seed_commissioner_membership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.league_members (league_id, user_id, role)
  values (new.id, new.commissioner_id, 'commissioner')
  on conflict (league_id, user_id) do update set role = 'commissioner';
  return new;
end;
$$;

create or replace function public.seed_default_roster_slots()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.roster_slots
    (league_id, slot_key, label, eligible_positions, count, is_starter, order_index)
  values
    (new.id,'QB',   'QB',    array['QB'],           1, true,  10),
    (new.id,'RB',   'RB',    array['RB'],           2, true,  20),
    (new.id,'WR',   'WR',    array['WR'],           2, true,  30),
    (new.id,'TE',   'TE',    array['TE'],           1, true,  40),
    (new.id,'FLEX', 'W/R/T', array['RB','WR','TE'], 1, true,  50),
    (new.id,'K',    'K',     array['K'],            1, true,  60),
    (new.id,'DEF',  'D/ST',  array['DEF'],          1, true,  70),
    (new.id,'BN',   'Bench', array[]::text[],       7, false, 80),
    (new.id,'IR',   'IR',    array[]::text[],       1, false, 90);
  return new;
end;
$$;

-- Reads the league to find the budget, so it needs to see the league.
create or replace function public.default_team_faab()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select faab_budget into new.faab_remaining
  from public.leagues where id = new.league_id;
  return new;
end;
$$;

-- A commissioner can always see their own league, membership row or not.
drop policy if exists leagues_read on public.leagues;
create policy leagues_read on public.leagues
  for select to authenticated
  using (commissioner_id = auth.uid() or public.is_league_member(id));
