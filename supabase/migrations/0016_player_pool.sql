-- =====================================================================
-- 0016  The player pool query
--
-- Powers the free agency / research page: every NFL player, with who
-- owns him in this league, whether he is sitting on waivers, and what he
-- has scored under this league's own scoring rules.
--
-- This is a function rather than three round trips plus a client-side
-- join because ownership and availability are the things you filter and
-- page on, and doing that in the client means fetching every player.
-- =====================================================================

create or replace function public.league_player_pool(
  p_league       uuid,
  p_search       text default null,
  p_position     text default null,   -- null/'' = every position
  p_availability text default 'all',  -- all | available | rostered | waivers
  p_sort         text default 'points',
  p_limit        int  default 50,
  p_offset       int  default 0
)
returns table (
  player_id        text,
  full_name        text,
  -- `position` is reserved in a RETURNS TABLE column list, hence `pos`
  pos              text,
  team_abbr        text,
  status           text,
  owner_team_id    uuid,
  owner_team_name  text,
  on_waivers       boolean,
  waiver_clears_at timestamptz,
  total_points     numeric,
  avg_points       numeric,
  games            bigint,
  last_points      numeric,
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
      o.team_id                         as owner_team_id,
      o.team_name                       as owner_team_name,
      (h.player_id is not null)         as on_waivers,
      h.clears_at                       as waiver_clears_at,
      coalesce(st.total_points, 0)      as total_points,
      coalesce(st.avg_points, 0)        as avg_points,
      coalesce(st.games, 0)             as games,
      coalesce(lw.points, 0)            as last_points
    from public.nfl_players p
    left join owned         o  on o.player_id  = p.id
    left join held          h  on h.player_id  = p.id
    left join season_totals st on st.player_id = p.id
    left join last_week     lw on lw.player_id = p.id
    where public.is_league_member(p_league)
      and (
        p_search is null or p_search = ''
        or p.search_name like '%' || lower(p_search) || '%'
      )
      and (p_position is null or p_position = '' or p.position = p_position)
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
    case when p_sort = 'points'      then f.total_points end desc nulls last,
    case when p_sort = 'last'        then f.last_points  end desc nulls last,
    case when p_sort = 'average'     then f.avg_points   end desc nulls last,
    case when p_sort = 'name'        then f.full_name    end asc  nulls last,
    f.total_points desc, f.full_name asc
  limit greatest(p_limit, 1)
  offset greatest(p_offset, 0);
$$;

grant execute on function public.league_player_pool(
  uuid, text, text, text, text, int, int
) to authenticated;

-- The positions actually present in the player table, for filter menus.
create or replace function public.available_positions()
returns table (pos text, player_count bigint)
language sql
stable
as $$
  select p.position, count(*)
  from public.nfl_players p
  where p.position is not null
  group by p.position
  order by count(*) desc;
$$;

grant execute on function public.available_positions() to authenticated;
