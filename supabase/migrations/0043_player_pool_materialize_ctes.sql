-- =====================================================================
-- 0043  Player pool: evaluate the per-player CTEs once, not per row
--
-- The Players tab was reported as very slow. Profiled against a realistic
-- pool (~2,700 players, 17 weeks of scores, a full season of
-- projections) the default page load took ~308 SECONDS.
--
-- Root cause: league_player_pool builds several per-player aggregates --
-- `season_totals`, `projection`, `last_week`, `bye`, `next_game` -- as
-- plain (inlined) CTEs, then LEFT JOINs each onto the ~2,700-row
-- nfl_players scan. With no row estimate to go on the planner drove those
-- joins as nested loops and *re-executed the whole aggregate once per
-- outer player row* (EXPLAIN showed loops=2756 on each, and 3.8M rows
-- removed by a single join filter). The projection aggregate alone --
-- every player's season line scored against the league's rules -- ran
-- 2,756 times per request.
--
-- Fix: mark those CTEs `materialized` so each is evaluated exactly once
-- into a worktable and then hash/merge-joined by key. This is purely an
-- execution-strategy change: the SQL, the columns, the filters, the
-- sort and the rows returned are byte-for-byte identical to 0039. It is
-- not an index or a schema change, so nothing else in the system moves.
--
-- Measured on the same fixture: ~308,000 ms -> ~180 ms (EXPLAIN ANALYZE
-- ~400 ms), i.e. roughly 1,700x, with the same 50 rows and the same
-- total_count. An added index on league_scoring_rules(stat_key) made no
-- difference (the rule lookup was already memoised); the cost was the
-- repeated aggregate, which only single-evaluation fixes.
--
-- Body is otherwise an exact copy of the 0039 definition.
-- =====================================================================

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
  -- `materialized`: these per-player aggregates are each referenced once
  -- below, which by default inlines them and lets the planner re-run the
  -- whole aggregate per outer row (see 0043 header). Forcing a single
  -- evaluation is the entire performance fix.
  season_totals as materialized (
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
  projection as materialized (
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
  last_week as materialized (
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
  bye as materialized (
    select tp.team, min(rw.week) as week
    from teams_playing tp
    cross join reg_weeks rw
    left join played p on p.team = tp.team and p.week = rw.week
    where p.team is null
    group by tp.team
  ),
  next_game as materialized (
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
  owned as materialized (
    select rp.player_id, rp.team_id, t.name as team_name
    from public.roster_players rp
    join public.teams t on t.id = rp.team_id
    where rp.league_id = p_league and rp.dropped_at is null
  ),
  held as materialized (
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
