-- =====================================================================
-- 0029  The trading block, and a player's trade value
--
-- On value: there is no free feed of dynasty-style trade values, and
-- inventing a proprietary-looking number would be worse than useless --
-- it would look authoritative while being made up. So the currency here
-- is deliberately plain and explainable in one sentence: what a player
-- is expected to score for the rest of the season under *this league's*
-- rules, being his own average so far times the weeks left.
--
-- That is a weak model and the UI says so. It has no idea about
-- schedule, injury, age or positional scarcity, and a player with two
-- huge games and a hamstring will be flattered by it. It is a starting
-- point for a conversation between two managers, not a verdict.
-- =====================================================================

alter table public.roster_players
  add column if not exists on_trading_block boolean not null default false;

create index if not exists roster_players_block_idx
  on public.roster_players(league_id)
  where on_trading_block and dropped_at is null;

-- Put one of your own players on, or take him off ----------------------
create or replace function public.set_trading_block(
  p_team uuid, p_player text, p_on boolean
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.owns_team(p_team) then
    raise exception 'That is not your team';
  end if;

  update public.roster_players
    set on_trading_block = p_on
    where team_id = p_team and player_id = p_player and dropped_at is null;

  if not found then
    raise exception 'That player is not on your roster';
  end if;
end;
$$;

grant execute on function public.set_trading_block(uuid, text, boolean)
  to authenticated;

/**
 * Every rostered player in a league, with a value and the numbers it
 * came from, so the UI can show its working.
 *
 * A player with no games yet has no average and so no value; he is
 * returned with zero rather than omitted, because "we do not know" is
 * something the trade finder needs to be able to say.
 */
create or replace function public.league_trade_values(p_league uuid)
returns table (
  player_id     text,
  full_name     text,
  pos           text,
  team_abbr     text,
  owner_team_id uuid,
  on_block      boolean,
  games         bigint,
  avg_points    numeric,
  total_points  numeric,
  weeks_left    int,
  value         numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with league as (
    select id, season, current_week, regular_season_weeks
    from public.leagues where id = p_league
  ),
  remaining as (
    -- Never zero: at the very end of the season a swap is still a swap,
    -- and dividing a whole roster to nothing helps nobody.
    select greatest(l.regular_season_weeks - l.current_week + 1, 1) as weeks
    from league l
  ),
  scored as (
    select pws.player_id,
           count(*)                  as games,
           round(avg(pws.points), 2) as avg_points,
           round(sum(pws.points), 2) as total_points
    from public.player_week_scores pws, league l
    where pws.league_id = p_league and pws.season = l.season
    group by pws.player_id
  )
  select
    rp.player_id,
    p.full_name,
    p.position,
    p.team_abbr,
    rp.team_id,
    rp.on_trading_block,
    coalesce(s.games, 0),
    coalesce(s.avg_points, 0),
    coalesce(s.total_points, 0),
    r.weeks,
    round(coalesce(s.avg_points, 0) * r.weeks, 1)
  from public.roster_players rp
  join public.nfl_players p on p.id = rp.player_id
  cross join remaining r
  left join scored s on s.player_id = rp.player_id
  where rp.league_id = p_league
    and rp.dropped_at is null
    and public.is_league_member(p_league);
$$;

grant execute on function public.league_trade_values(uuid) to authenticated;
