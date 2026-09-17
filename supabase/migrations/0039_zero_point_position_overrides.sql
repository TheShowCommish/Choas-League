-- =====================================================================
-- 0039  A position override of 0 means zero
--
-- 0030 let a stat be worth different amounts by position, and picked
-- the most specific rule that matched. But the lookup also filtered on
-- `points <> 0` BEFORE choosing, so an override of 0 was never a
-- candidate: a receiver's tackle, overridden to 0 under a base of 5,
-- fell straight through to the base and scored 5. The product's own
-- example -- a quarterback's tackle scores and a receiver's does not --
-- could not be expressed.
--
-- Weekly projections (projected_points, team_projections) already went
-- through scoring_rule_points, which has no such filter, so projected
-- and actual points disagreed. Season projections were worse: a plain
-- join summed the base rule AND the override for any position that had
-- one.
--
-- Now every scorer resolves the rule the same way: pick the most
-- specific rule first, whatever its points, and only then drop the
-- stats whose chosen rule is worth nothing. Dropping afterwards keeps
-- zero-point stats out of breakdowns and totals, as before.
--
-- recompute_week_scores also clears the scores it no longer produces. It
-- only ever upserted, so a player whose every stat now scores 0 (the
-- receiver above, with nothing but a tackle) kept his old 5 forever.
--
-- Leagues that already hold a 0-point override are rescored at the end.
-- As with saving a rule, open matchups pick up the new totals and final
-- matchups keep theirs.
-- =====================================================================

-- Rescore using the most specific rule, even when it is worth 0 --------
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
  if auth.uid() is not null and not public.is_commissioner(p_league) then
    raise exception 'Only the commissioner can recompute scores';
  end if;

  with scored as (
    select
      pgs.player_id,
      pgs.season,
      pgs.week,
      bool_and(pgs.source = 'final')          as is_final,
      sum(public.safe_numeric(kv.value) * r.points) as points,
      jsonb_object_agg(
        kv.key,
        jsonb_build_object(
          'value',  public.safe_numeric(kv.value),
          'points', round(public.safe_numeric(kv.value) * r.points, 2)
        )
      )                                       as breakdown
    from public.player_game_stats pgs
    join public.nfl_players pl on pl.id = pgs.player_id
    cross join lateral jsonb_each_text(pgs.stats) as kv(key, value)
    -- Exactly one rule per stat: the most specific that matches, chosen
    -- before its points are looked at, so an override of 0 beats the
    -- base rule it overrides.
    join lateral (
      select r.points
      from public.league_scoring_rules r
      where r.league_id = p_league
        and r.stat_key  = kv.key
        and (
          cardinality(r.positions) = 0
          or (pl.position is not null and pl.position = any(r.positions))
        )
      order by cardinality(r.positions) desc
      limit 1
    ) r on true
    where pgs.season = p_season
      and pgs.week   = p_week
      and r.points  <> 0
      and public.safe_numeric(kv.value) is not null
      and public.safe_numeric(kv.value) <> 0
    group by pgs.player_id, pgs.season, pgs.week
  ),
  -- Anybody scored earlier who scores nothing now. Removed rather than
  -- zeroed, so the table matches what a first computation would write.
  cleared as (
    delete from public.player_week_scores pws
    where pws.league_id = p_league
      and pws.season    = p_season
      and pws.week      = p_week
      and not exists (
        select 1 from scored s where s.player_id = pws.player_id
      )
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

-- Season projections: one rule per stat, 0 included ---------------------
--
-- Same resolution as recompute_week_scores. The old plain join also
-- counted a stat once per matching rule, base and override together.
create or replace function public.league_season_projection(
  p_league uuid, p_season int
) returns table (player_id text, points numeric)
language sql
stable
security definer
set search_path = public
as $$
  select psp.player_id,
         round(coalesce(sum(public.safe_numeric(kv.value) * r.points), 0), 2)
  from public.player_season_projections psp
  join public.nfl_players pl on pl.id = psp.player_id
  cross join lateral jsonb_each_text(psp.stats) as kv(key, value)
  join lateral (
    select r.points
    from public.league_scoring_rules r
    where r.league_id = p_league
      and r.stat_key  = kv.key
      and (
        cardinality(r.positions) = 0
        or (pl.position is not null and pl.position = any(r.positions))
      )
    order by cardinality(r.positions) desc
    limit 1
  ) r on true
  where psp.season = p_season
    and r.points  <> 0
    and (auth.uid() is null or public.is_league_member(p_league))
  group by psp.player_id;
$$;

grant execute on function public.league_season_projection(uuid, int)
  to authenticated;

-- The player pool's inlined copy of the season projection ---------------
--
-- Unchanged from 0036 apart from the projection CTE.
create or replace function public.league_player_pool(
  p_league       uuid,
  p_search       text default null,
  p_position     text default null,   -- null/'' = every position; 'FLEX' = flex-eligible
  p_availability text default 'all',  -- all | available | rostered | waivers
  p_sort         text default 'points',
  p_limit        int  default 50,
  p_offset       int  default 0,
  p_team         text default null,   -- NFL team abbreviation
  p_dir          text default 'desc'  -- asc | desc
)
returns table (
  player_id        text,
  full_name        text,
  pos              text,
  team_abbr        text,
  status           text,
  headshot_url     text,
  owner_team_id    uuid,
  owner_team_name  text,
  on_waivers       boolean,
  waiver_clears_at timestamptz,
  total_points     numeric,
  avg_points       numeric,
  games            bigint,
  last_points      numeric,
  adp              numeric,
  adp_rank         int,
  proj_points      numeric,
  injury_status    text,
  injury_body_part text,
  bye_week         int,
  next_opponent    text,
  next_kickoff     timestamptz,
  next_is_home     boolean,
  total_count      bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with league as (
    select id, season, current_week from public.leagues where id = p_league
  ),
  wanted as (
    select case
      when upper(coalesce(p_position, '')) = 'FLEX'
        then public.league_flex_positions(p_league)
      when coalesce(p_position, '') = ''
        then null::text[]
      else array[p_position]
    end as positions
  ),
  season_totals as (
    select pws.player_id,
           round(sum(pws.points), 2) as total_points,
           round(avg(pws.points), 2) as avg_points,
           count(*)                  as games
    from public.player_week_scores pws, league l
    where pws.league_id = p_league and pws.season = l.season
    group by pws.player_id
  ),
  -- This season's projection, scored with this league's rules. Inlined
  -- rather than calling league_season_projection so the planner sees one
  -- query rather than a definer function per pool read.
  projection as (
    select psp.player_id,
           round(coalesce(sum(public.safe_numeric(kv.value) * r.points), 0), 2)
             as points
    from public.player_season_projections psp
    join public.nfl_players pl on pl.id = psp.player_id
    cross join league l
    cross join lateral jsonb_each_text(psp.stats) as kv(key, value)
    -- The most specific rule, even one worth 0, as in
    -- league_season_projection above.
    join lateral (
      select r.points
      from public.league_scoring_rules r
      where r.league_id = p_league
        and r.stat_key  = kv.key
        and (
          cardinality(r.positions) = 0
          or (pl.position is not null and pl.position = any(r.positions))
        )
      order by cardinality(r.positions) desc
      limit 1
    ) r on true
    where psp.season = l.season
      and r.points  <> 0
    group by psp.player_id
  ),
  last_week as (
    select pws.player_id, pws.points
    from public.player_week_scores pws, league l
    where pws.league_id = p_league
      and pws.season = l.season
      and pws.week = greatest(l.current_week - 1, 1)
  ),
  -- The one week in the regular season an NFL team does not play.
  --
  -- Derived from the schedule rather than stored, so it cannot go
  -- stale, and only over the weeks the schedule actually holds -- a
  -- half-loaded season would otherwise report week 1 as everybody's bye.
  played as (
    select g.home_team as team, g.week
    from public.nfl_games g, league l
    where g.season = l.season and g.season_type = 'REG'
      and g.home_team is not null
    union all
    select g.away_team, g.week
    from public.nfl_games g, league l
    where g.season = l.season and g.season_type = 'REG'
      and g.away_team is not null
  ),
  reg_weeks as (select distinct week from played),
  teams_playing as (select distinct team from played),
  bye as (
    select tp.team, min(rw.week) as week
    from teams_playing tp
    cross join reg_weeks rw
    left join played p on p.team = tp.team and p.week = rw.week
    where p.team is null
    group by tp.team
  ),
  next_game as (
    select g.home_team as team, g.away_team as opponent,
           g.kickoff_at, true as is_home
    from public.nfl_games g, league l
    where g.season = l.season and g.week = l.current_week
      and g.season_type = 'REG'
    union all
    select g.away_team, g.home_team, g.kickoff_at, false
    from public.nfl_games g, league l
    where g.season = l.season and g.week = l.current_week
      and g.season_type = 'REG'
  ),
  owned as (
    select rp.player_id, rp.team_id, t.name as team_name
    from public.roster_players rp
    join public.teams t on t.id = rp.team_id
    where rp.league_id = p_league and rp.dropped_at is null
  ),
  held as (
    select wh.player_id, wh.clears_at
    from public.waiver_holds wh
    where wh.league_id = p_league and wh.clears_at > now()
  ),
  filtered as (
    select
      p.id                              as player_id,
      p.full_name,
      p.position                        as pos,
      p.team_abbr,
      p.status,
      p.headshot_url,
      o.team_id                         as owner_team_id,
      o.team_name                       as owner_team_name,
      (h.player_id is not null)         as on_waivers,
      h.clears_at                       as waiver_clears_at,
      coalesce(st.total_points, 0)      as total_points,
      coalesce(st.avg_points, 0)        as avg_points,
      coalesce(st.games, 0)             as games,
      coalesce(lw.points, 0)            as last_points,
      p.adp,
      p.adp_rank,
      pr.points                         as proj_points,
      p.injury_status,
      p.injury_body_part,
      bw.week                           as bye_week,
      ng.opponent                       as next_opponent,
      ng.kickoff_at                     as next_kickoff,
      ng.is_home                        as next_is_home
    from public.nfl_players p
    cross join wanted w
    left join owned         o  on o.player_id  = p.id
    left join held          h  on h.player_id  = p.id
    left join season_totals st on st.player_id = p.id
    left join projection    pr on pr.player_id = p.id
    left join last_week     lw on lw.player_id = p.id
    left join bye           bw on bw.team      = p.team_abbr
    left join next_game     ng on ng.team      = p.team_abbr
    where public.is_league_member(p_league)
      and public.is_fantasy_player(p.id, p.position)
      and (
        p_search is null or p_search = ''
        or p.search_name like '%' || lower(p_search) || '%'
      )
      and (w.positions is null or p.position = any (w.positions))
      and (p_team is null or p_team = '' or p.team_abbr = p_team)
      and (
        p_availability = 'all'
        or (p_availability = 'available' and o.team_id is null and h.player_id is null)
        or (p_availability = 'waivers'   and h.player_id is not null)
        or (p_availability = 'rostered'  and o.team_id is not null)
      )
  )
  select f.*, count(*) over () as total_count
  from filtered f
  order by
    -- ADP is the one key whose natural direction is ascending: 1.01 is
    -- the best player, not the worst. 'desc' on it is still honoured, it
    -- just is not what anybody means by "sort by ADP".
    case when p_dir <> 'asc' and p_sort = 'adp'      then f.adp          end asc  nulls last,
    case when p_dir =  'asc' and p_sort = 'adp'      then f.adp          end desc nulls last,
    -- Descending
    case when p_dir <> 'asc' and p_sort = 'points'     then f.total_points end desc nulls last,
    case when p_dir <> 'asc' and p_sort = 'projection' then f.proj_points  end desc nulls last,
    case when p_dir <> 'asc' and p_sort = 'last'     then f.last_points  end desc nulls last,
    case when p_dir <> 'asc' and p_sort = 'average'  then f.avg_points   end desc nulls last,
    case when p_dir <> 'asc' and p_sort = 'games'    then f.games        end desc nulls last,
    case when p_dir <> 'asc' and p_sort = 'kickoff'  then f.next_kickoff end desc nulls last,
    case when p_dir <> 'asc' and p_sort = 'name'     then f.full_name    end desc nulls last,
    case when p_dir <> 'asc' and p_sort = 'position' then f.pos          end desc nulls last,
    case when p_dir <> 'asc' and p_sort = 'team'     then f.team_abbr    end desc nulls last,
    case when p_dir <> 'asc' and p_sort = 'opponent' then f.next_opponent end desc nulls last,
    case when p_dir <> 'asc' and p_sort = 'owner'    then f.owner_team_name end desc nulls last,
    -- Ascending
    case when p_dir = 'asc' and p_sort = 'points'     then f.total_points end asc nulls last,
    case when p_dir = 'asc' and p_sort = 'projection' then f.proj_points  end asc nulls last,
    case when p_dir = 'asc' and p_sort = 'last'      then f.last_points  end asc nulls last,
    case when p_dir = 'asc' and p_sort = 'average'   then f.avg_points   end asc nulls last,
    case when p_dir = 'asc' and p_sort = 'games'     then f.games        end asc nulls last,
    case when p_dir = 'asc' and p_sort = 'kickoff'   then f.next_kickoff end asc nulls last,
    case when p_dir = 'asc' and p_sort = 'name'      then f.full_name    end asc nulls last,
    case when p_dir = 'asc' and p_sort = 'position'  then f.pos          end asc nulls last,
    case when p_dir = 'asc' and p_sort = 'team'      then f.team_abbr    end asc nulls last,
    case when p_dir = 'asc' and p_sort = 'opponent'  then f.next_opponent end asc nulls last,
    case when p_dir = 'asc' and p_sort = 'owner'     then f.owner_team_name end asc nulls last,
    -- A stable tiebreak, so paging cannot repeat or skip a row.
    f.total_points desc, f.player_id asc
  limit greatest(p_limit, 1)
  offset greatest(p_offset, 0);
$$;

grant execute on function public.league_player_pool(
  uuid, text, text, text, text, int, int, text, text
) to authenticated;

-- Rescore the leagues this changes ---------------------------------------
--
-- Only a league holding a positional rule worth 0 scores differently
-- under the new lookup; everybody else's stored numbers are already
-- right. recompute_season_scores rescores every week with stats and
-- leaves final matchups alone, exactly as saving a rule does.
do $$
declare
  v_league uuid;
begin
  for v_league in
    select distinct r.league_id
    from public.league_scoring_rules r
    where cardinality(r.positions) > 0
      and r.points = 0
  loop
    perform public.recompute_season_scores(v_league);
  end loop;
end;
$$;
