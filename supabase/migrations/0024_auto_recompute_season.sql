-- =====================================================================
-- 0024  Scoring a whole season in one call, and doing it automatically
--
-- Three related problems, one function.
--
--   1. recompute_all_leagues only runs from the ingestion job, so it
--      only ever sees leagues that existed when the stats landed. A
--      league created after the last sync had scoring rules but no
--      player_week_scores at all, and stayed that way until somebody
--      remembered to press "recompute" in the admin tools.
--
--   2. The client-side "recompute all weeks" looped 1..current_week.
--      A league sitting at week 1 with a finished season of stats
--      behind it therefore rescored exactly one week.
--
--   3. Changing a scoring rule is retroactive by nature, but saving
--      one only told you to go and rescore by hand.
--
-- The fix for all three is to score the weeks that actually have stats,
-- rather than the weeks somebody guessed at.
-- =====================================================================

create or replace function public.recompute_season_scores(p_league uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season int;
  v_week   int;
  v_weeks  int := 0;
begin
  select season into v_season from public.leagues where id = p_league;
  if v_season is null then
    raise exception 'No such league';
  end if;

  -- auth.uid() is null == the ingestion jobs under the service role.
  if auth.uid() is not null and not public.is_league_member(p_league) then
    raise exception 'That is not your league';
  end if;

  -- Only the weeks we hold stats for. A league created in a season that
  -- has not started yet does no work at all and returns 0.
  for v_week in
    select distinct week
    from public.player_game_stats
    where season = v_season
    order by week
  loop
    perform public.recompute_week_scores(p_league, v_season, v_week);
    v_weeks := v_weeks + 1;
  end loop;

  return v_weeks;
end;
$$;

grant execute on function public.recompute_season_scores(uuid) to authenticated;

-- Score a new league against the season it just joined ------------------
--
-- Deferred to a statement-level AFTER trigger rather than done inline in
-- the row trigger: the scoring rules are seeded by their own AFTER
-- trigger (0011) and would not be visible yet.
create or replace function public.seed_new_league_scores()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Never let scoring take league creation down with it. A league with
  -- no scores is recoverable from the admin tools; a league that could
  -- not be created at all is not.
  begin
    perform public.recompute_season_scores(new.id);
  exception when others then
    raise warning 'Could not score new league %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

-- Ordering among AFTER triggers on the same table is alphabetical by
-- trigger name, so this has to sort after leagues_seed_scoring.
drop trigger if exists leagues_zz_seed_scores on public.leagues;
create trigger leagues_zz_seed_scores after insert on public.leagues
  for each row execute function public.seed_new_league_scores();
