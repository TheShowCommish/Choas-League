-- =====================================================================
-- 0012  The scoring engine
--
-- Fantasy points are a join, not a hard-coded formula: every stat in a
-- player's jsonb line is matched against the league's rule table and
-- multiplied by its points-per-unit. Add a stat to the catalog and it
-- becomes scorable with no code change here.
--
-- Team defenses need no special case: they are players with a
-- 'DST_<abbr>' id and position 'DEF', so the dst_* rules only ever match
-- their rows.
-- =====================================================================

-- jsonb values are text; a stat we can't read as a number is skipped
-- rather than blowing up the whole week's recompute.
create or replace function public.safe_numeric(p text)
returns numeric
language plpgsql
immutable
as $$
begin
  return p::numeric;
exception when others then
  return null;
end;
$$;

-- What each fantasy team's *starters* scored in one week ----------------
create or replace function public.team_week_points(
  p_league uuid, p_season int, p_week int
) returns table (team_id uuid, points numeric)
language sql
stable
security definer
set search_path = public
as $$
  select le.team_id,
         round(sum(coalesce(pws.points, 0)), 2) as points
  from public.lineup_entries le
  join public.roster_slots rs
    on rs.league_id = p_league
   and rs.slot_key  = le.slot_key
   and rs.is_starter
  left join public.player_week_scores pws
    on pws.league_id = p_league
   and pws.season    = le.season
   and pws.week      = le.week
   and pws.player_id = le.player_id
  where le.league_id = p_league
    and le.season    = p_season
    and le.week      = p_week
  group by le.team_id;
$$;

-- Roll starters' points up into the head-to-head matchups ---------------
create or replace function public.recompute_matchup_scores(
  p_league uuid, p_season int, p_week int
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Teams with no lineup at all still need their score zeroed out.
  update public.matchups
    set home_score = 0, away_score = 0
    where league_id = p_league and season = p_season and week = p_week
      and status <> 'final';

  update public.matchups m
    set home_score = tp.points
    from public.team_week_points(p_league, p_season, p_week) tp
    where m.league_id = p_league and m.season = p_season and m.week = p_week
      and m.status <> 'final'
      and m.home_team_id = tp.team_id;

  update public.matchups m
    set away_score = tp.points
    from public.team_week_points(p_league, p_season, p_week) tp
    where m.league_id = p_league and m.season = p_season and m.week = p_week
      and m.status <> 'final'
      and m.away_team_id = tp.team_id;
end;
$$;

-- Recompute every fantasy score for one league-week --------------------
create or replace function public.recompute_week_scores(
  p_league uuid, p_season int, p_week int
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int := 0;
begin
  with scored as (
    select
      pgs.player_id,
      pgs.season,
      pgs.week,
      bool_and(pgs.source = 'final')                as is_final,
      sum(public.safe_numeric(kv.value) * r.points) as points,
      jsonb_object_agg(
        kv.key,
        jsonb_build_object(
          'value',  public.safe_numeric(kv.value),
          'points', round(public.safe_numeric(kv.value) * r.points, 2)
        )
      )                                             as breakdown
    from public.player_game_stats pgs
    join public.nfl_players pl on pl.id = pgs.player_id
    cross join lateral jsonb_each_text(pgs.stats) as kv(key, value)
    join public.league_scoring_rules r
      on r.league_id = p_league
     and r.stat_key  = kv.key
     and r.points   <> 0
     and (cardinality(r.positions) = 0 or pl.position = any(r.positions))
    where pgs.season = p_season
      and pgs.week   = p_week
      and public.safe_numeric(kv.value) is not null
      and public.safe_numeric(kv.value) <> 0
    group by pgs.player_id, pgs.season, pgs.week
  )
  insert into public.player_week_scores
    (league_id, player_id, season, week, points, breakdown, is_final, computed_at)
  select p_league, player_id, season, week,
         round(coalesce(points, 0), 2), coalesce(breakdown, '{}'::jsonb),
         is_final, now()
  from scored
  on conflict (league_id, player_id, season, week)
  do update set
    points      = excluded.points,
    breakdown   = excluded.breakdown,
    is_final    = excluded.is_final,
    computed_at = now();

  get diagnostics v_rows = row_count;

  perform public.recompute_matchup_scores(p_league, p_season, p_week);
  return v_rows;
end;
$$;

-- Recompute every league running that season, for one NFL week ---------
-- Called by the ingestion job once new stats land.
create or replace function public.recompute_all_leagues(p_season int, p_week int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league uuid;
  v_count  int := 0;
begin
  for v_league in select id from public.leagues where season = p_season
  loop
    perform public.recompute_week_scores(v_league, p_season, p_week);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Close out a week: score it once more, then freeze the results ---------
create or replace function public.finalize_week(p_league uuid, p_season int, p_week int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.recompute_week_scores(p_league, p_season, p_week);

  update public.matchups
    set status = 'final'
    where league_id = p_league and season = p_season and week = p_week;
end;
$$;

grant execute on function public.safe_numeric(text)                       to authenticated;
grant execute on function public.team_week_points(uuid, int, int)         to authenticated;
grant execute on function public.recompute_week_scores(uuid, int, int)    to authenticated;
grant execute on function public.recompute_matchup_scores(uuid, int, int) to authenticated;
