-- =====================================================================
-- 0027  Sorting, an NFL team filter, and next week's fixture
--
-- The pool sorted by one of four fixed keys, always descending, and had
-- no idea what any of these players were about to do. Sorting has to
-- happen here rather than in the client because the page shows fifty of
-- several thousand rows: sorting the visible page sorts the wrong set.
-- =====================================================================

drop function if exists public.league_player_pool(
  uuid, text, text, text, text, int, int
);

create or replace function public.league_player_pool(
  p_league       uuid,
  p_search       text default null,
  p_position     text default null,   -- null/'' = every position
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
  -- Next week's fixture, for deciding who to start
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
  season_totals as (
    select pws.player_id,
           round(sum(pws.points), 2) as total_points,
           round(avg(pws.points), 2) as avg_points,
           count(*)                  as games
    from public.player_week_scores pws, league l
    where pws.league_id = p_league and pws.season = l.season
    group by pws.player_id
  ),
  last_week as (
    select pws.player_id, pws.points
    from public.player_week_scores pws, league l
    where pws.league_id = p_league
      and pws.season = l.season
      and pws.week = greatest(l.current_week - 1, 1)
  ),
  -- One fixture per NFL team for the league's current week. A team on a
  -- bye simply has no row, which is how the UI tells the difference.
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
      ng.opponent                       as next_opponent,
      ng.kickoff_at                     as next_kickoff,
      ng.is_home                        as next_is_home
    from public.nfl_players p
    left join owned         o  on o.player_id  = p.id
    left join held          h  on h.player_id  = p.id
    left join season_totals st on st.player_id = p.id
    left join last_week     lw on lw.player_id = p.id
    left join next_game     ng on ng.team      = p.team_abbr
    where public.is_league_member(p_league)
      and (
        p_search is null or p_search = ''
        or p.search_name like '%' || lower(p_search) || '%'
      )
      and (p_position is null or p_position = '' or p.position = p_position)
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
    -- Descending
    case when p_dir <> 'asc' and p_sort = 'points'   then f.total_points end desc nulls last,
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
    case when p_dir = 'asc' and p_sort = 'points'    then f.total_points end asc nulls last,
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

-- The NFL teams that actually have players, for the filter menu.
create or replace function public.available_nfl_teams()
returns table (abbr text, player_count bigint)
language sql
stable
as $$
  select p.team_abbr, count(*)
  from public.nfl_players p
  where p.team_abbr is not null
  group by p.team_abbr
  order by p.team_abbr;
$$;

grant execute on function public.available_nfl_teams() to authenticated;
