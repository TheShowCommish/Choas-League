-- =====================================================================
-- 0033  Give existing leagues the rules for newly added stats
--
-- seed_default_scoring_rules runs once, on league creation. Adding a
-- stat to the catalog afterwards therefore reaches new leagues and no
-- others: an existing league has no rule row for it, so it scores
-- nothing and the catalog default is quietly ignored.
--
-- That went unnoticed while the catalog was fixed. Punting and head
-- coaching added nineteen stats, several with meaningful defaults, so it
-- matters now.
--
-- Only missing base rules are inserted. A commissioner who has already
-- set a value -- including deliberately setting it to zero -- keeps it,
-- and per-position overrides are untouched.
-- =====================================================================

insert into public.league_scoring_rules (league_id, stat_key, points, positions)
select l.id, d.key, d.default_points, '{}'::text[]
from public.leagues l
cross join public.stat_definitions d
where d.scorable
  and not exists (
    select 1 from public.league_scoring_rules r
    where r.league_id = l.id
      and r.stat_key = d.key
      and cardinality(r.positions) = 0
  );

/**
 * The same thing on demand, so this is not a one-off.
 *
 * Called after regenerating the catalog, or from the admin tools, to
 * pick up whatever has been added since a league was created. Returns
 * how many rules it had to add.
 */
create or replace function public.backfill_scoring_rules(p_league uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_added int;
begin
  if not public.is_commissioner(p_league) then
    raise exception 'Only the commissioner can do that';
  end if;

  insert into public.league_scoring_rules (league_id, stat_key, points, positions)
  select p_league, d.key, d.default_points, '{}'::text[]
  from public.stat_definitions d
  where d.scorable
    and not exists (
      select 1 from public.league_scoring_rules r
      where r.league_id = p_league
        and r.stat_key = d.key
        and cardinality(r.positions) = 0
    );

  get diagnostics v_added = row_count;
  return v_added;
end;
$$;

grant execute on function public.backfill_scoring_rules(uuid) to authenticated;
