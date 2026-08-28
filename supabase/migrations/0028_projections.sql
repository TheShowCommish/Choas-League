-- =====================================================================
-- 0028  Weekly projections
--
-- A projection is stored as a stat line, not a points total, for the
-- same reason a real game is: points depend on the league's rules. A
-- projected 22 PPR points means nothing in a league that pays 50 for a
-- quarterback's tackle. Keeping the line lets the projection be scored
-- through the same rule table as everything else, so what you see on the
-- player page is a projection *in your league*.
-- =====================================================================

create table if not exists public.player_week_projections (
  player_id      text not null references public.nfl_players(id) on delete cascade,
  season         int  not null,
  week           int  not null,
  stats          jsonb not null default '{}'::jsonb,
  opponent       text,
  injury_status  text,
  source         text not null default 'sleeper',
  updated_at     timestamptz not null default now(),
  primary key (player_id, season, week)
);

create index if not exists pwp_week_idx
  on public.player_week_projections(season, week);

alter table public.player_week_projections enable row level security;

-- Same shape as the other NFL reference data: readable by anyone signed
-- in, written only by the ingestion job under the service role.
drop policy if exists pwp_read on public.player_week_projections;
create policy pwp_read on public.player_week_projections
  for select to authenticated using (true);

/**
 * Scores a projected stat line with a league's own rules.
 *
 * Deliberately the same shape as the scoring in recompute_week_scores:
 * walk the jsonb, join the rule table, multiply. Anything the league
 * does not score contributes nothing, which is the point.
 */
create or replace function public.projected_points(
  p_league uuid, p_player text, p_season int, p_week int
) returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select round(coalesce(sum(public.safe_numeric(kv.value) * r.points), 0), 2)
  from public.player_week_projections pwp
  join public.nfl_players pl on pl.id = pwp.player_id
  cross join lateral jsonb_each_text(pwp.stats) as kv(key, value)
  join public.league_scoring_rules r
    on r.league_id = p_league
   and r.stat_key  = kv.key
   and r.points   <> 0
   and (cardinality(r.positions) = 0 or pl.position = any(r.positions))
  where pwp.player_id = p_player
    and pwp.season    = p_season
    and pwp.week      = p_week
    and public.is_league_member(p_league);
$$;

grant execute on function public.projected_points(uuid, text, int, int)
  to authenticated;

/**
 * The same thing for a whole team's roster, so the lineup page can show
 * what each player is projected to do without a query per row.
 */
create or replace function public.team_projections(
  p_league uuid, p_team uuid, p_season int, p_week int
) returns table (player_id text, points numeric)
language sql
stable
security definer
set search_path = public
as $$
  select rp.player_id,
         round(coalesce(sum(public.safe_numeric(kv.value) * r.points), 0), 2)
  from public.roster_players rp
  join public.nfl_players pl on pl.id = rp.player_id
  left join public.player_week_projections pwp
    on pwp.player_id = rp.player_id
   and pwp.season    = p_season
   and pwp.week      = p_week
  left join lateral jsonb_each_text(coalesce(pwp.stats, '{}'::jsonb))
    as kv(key, value) on true
  left join public.league_scoring_rules r
    on r.league_id = p_league
   and r.stat_key  = kv.key
   and r.points   <> 0
   and (cardinality(r.positions) = 0 or pl.position = any(r.positions))
  where rp.team_id = p_team
    and rp.dropped_at is null
    and public.is_league_member(p_league)
  group by rp.player_id;
$$;

grant execute on function public.team_projections(uuid, uuid, int, int)
  to authenticated;
