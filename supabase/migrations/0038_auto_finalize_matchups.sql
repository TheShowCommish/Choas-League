-- =====================================================================
-- 0038  Matchups finish on their own, and know how long they last
--
-- finalize_week was only ever called by the test-league seed script.
-- Nothing in production closed a matchup, so standings (which count
-- only final games) sat at 0-0 all season and advance_playoffs refused
-- every round as "not final".
--
-- It also predated multi-week matchups. It closed everything with
-- week = p_week, which would end a two-week semi-final after its first
-- week. A matchup is now final once the LAST week it covers
-- (week + week_count - 1) is finalized, and not before.
--
-- The pieces:
--
--   close_matchups         internal. Rescores and freezes the open
--                          matchups that end in a week (optionally only
--                          some of them). No authorisation of its own.
--   finalize_week          one league, one week. Closes the matchups that
--                          end in that week. Commissioner or the jobs.
--   nfl_week_is_complete   has the real week finished? Every game final
--                          (or postponed) with official stats, the last
--                          kickoff long enough ago for corrections.
--   finalize_completed_weeks
--                          the cron job: every in-season league, every
--                          open matchup whose weeks are ALL complete.
--
-- All of it is idempotent. A final matchup is never touched again.
-- =====================================================================

-- The return type changes (void -> int), which create or replace cannot do.
drop function if exists public.finalize_week(uuid, int, int);

/**
 * Rescore and freeze the open matchups in a league that end in `p_week`.
 * `p_ids` limits it to those matchups; null means all of them.
 *
 * Every week a closing matchup spans is rescored, not just the last, so
 * a stat correction to the first week of a two-week round is counted.
 *
 * Internal: callers do their own authorisation.
 */
create or replace function public.close_matchups(
  p_league uuid, p_season int, p_week int, p_ids uuid[]
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from   int;
  v_w      int;
  v_closed int := 0;
begin
  select min(week) into v_from
    from public.matchups
    where league_id = p_league
      and season = p_season
      and status <> 'final'
      and week + week_count - 1 = p_week
      and (p_ids is null or id = any(p_ids));

  if v_from is null then
    return 0;
  end if;

  for v_w in v_from..p_week loop
    perform public.recompute_week_scores(p_league, p_season, v_w);
  end loop;

  update public.matchups
    set status = 'final'
    where league_id = p_league
      and season = p_season
      and status <> 'final'
      and week + week_count - 1 = p_week
      and (p_ids is null or id = any(p_ids));

  get diagnostics v_closed = row_count;
  return v_closed;
end;
$$;

revoke execute on function public.close_matchups(uuid, int, int, uuid[])
  from public, anon, authenticated;

/**
 * Close out the matchups that end in `p_week`: score them once more,
 * then freeze them. The commissioner's override, and the seed script.
 *
 * Returns how many matchups were closed. Zero is not an error: the week
 * may already be final, or be the first half of a two-week round.
 */
create function public.finalize_week(
  p_league uuid, p_season int, p_week int
) returns int
language plpgsql
security definer
set search_path = public
as $$
begin
  -- auth.uid() is null == the ingestion jobs under the service role.
  if auth.uid() is not null and not public.is_commissioner(p_league) then
    raise exception 'Only the commissioner can finalize a week';
  end if;

  -- A person typing a week number can mistype it, and a final matchup is
  -- never reopened. Refuse a week that has not been played. (The scheduled
  -- job goes through close_matchups, after nfl_week_is_complete.)
  if auth.uid() is not null and (
    not exists (
      select 1 from public.nfl_games
      where season = p_season and week = p_week and season_type <> 'PRE'
    )
    or exists (
      select 1 from public.nfl_games
      where season = p_season and week = p_week and season_type <> 'PRE'
        and kickoff_at > now()
    )
  ) then
    raise exception 'Week % has not been played yet', p_week;
  end if;

  return public.close_matchups(p_league, p_season, p_week, null);
end;
$$;

-- A signed-out visitor also has auth.uid() null, so the check above
-- would wave them through. They get no execute at all; the jobs reach
-- this as service_role, which Supabase grants separately.
revoke execute on function public.finalize_week(uuid, int, int) from public, anon;
grant execute on function public.finalize_week(uuid, int, int) to authenticated;

/**
 * Whether an NFL week is over and its numbers are settled.
 *
 * Complete means: the week has games on the schedule, every one of them
 * is final or postponed, the last kickoff was at least `p_grace` before
 * `p_as_of`, and every final game has official (source = 'final') stat
 * lines. A final matchup is never rescored, so freezing it on the live
 * feed's provisional numbers would lose the corrections for good.
 *
 * Official stats are matched game by game rather than "no live rows
 * left": a live row for a player nflverse never maps would otherwise
 * hold the week open forever.
 */
create or replace function public.nfl_week_is_complete(
  p_season int,
  p_week   int,
  p_grace  interval    default interval '36 hours',
  p_as_of  timestamptz default now()
) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    count(*) > 0
    and bool_and(g.status in ('final', 'postponed'))
    and max(g.kickoff_at) <= p_as_of - p_grace
    and bool_and(
      g.status <> 'final'
      or exists (
        select 1 from public.player_game_stats s
        where s.game_id = g.id and s.source = 'final'
      )
    ),
    false
  )
  from public.nfl_games g
  where g.season = p_season
    and g.week = p_week
    and g.season_type <> 'PRE';
$$;

grant execute on function public.nfl_week_is_complete(int, int, interval, timestamptz)
  to authenticated;

/**
 * The scheduled job: finalize every open matchup whose weeks are all
 * complete, in every league whose season is under way.
 *
 * Every week a matchup covers must be complete, not just its last: a
 * two-week round whose first week still has an unfinished game stays
 * open for the commissioner to deal with.
 *
 * Leagues in 'setup' or 'drafting' (or 'complete') are skipped. A league
 * still being set up has no business having last month closed as 0-0.
 *
 * Returns one row per league-week that closed something. Running it again
 * straight away returns nothing, because there is nothing left open.
 *
 * Only the ingestion jobs may call it (see set_player_adp in 0035 for why
 * a missing role counts as trusted).
 */
create or replace function public.finalize_completed_weeks(
  p_grace interval    default interval '36 hours',
  p_as_of timestamptz default now()
) returns table (league_id uuid, season int, week int, closed int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_row  record;
  v_ids  uuid[];
  v_n    int;
begin
  v_role := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role',
    'service_role'
  );

  if v_role <> 'service_role' then
    raise exception 'Only the scheduled jobs can finalize every league';
  end if;

  for v_row in
    select distinct m.league_id, m.season, m.week + m.week_count - 1 as end_week
    from public.matchups m
    join public.leagues l on l.id = m.league_id
    where m.status <> 'final'
      and l.status in ('in_season', 'playoffs')
    order by m.league_id, end_week
  loop
    select array_agg(m.id) into v_ids
      from public.matchups m
      where m.league_id = v_row.league_id
        and m.season = v_row.season
        and m.status <> 'final'
        and m.week + m.week_count - 1 = v_row.end_week
        and not exists (
          select 1
          from generate_series(m.week, v_row.end_week) as w(n)
          where not public.nfl_week_is_complete(
                  v_row.season, w.n, p_grace, p_as_of)
        );

    if v_ids is not null then
      v_n := public.close_matchups(
        v_row.league_id, v_row.season, v_row.end_week, v_ids);
      if v_n > 0 then
        league_id := v_row.league_id;
        season    := v_row.season;
        week      := v_row.end_week;
        closed    := v_n;
        return next;
      end if;
    end if;
  end loop;
end;
$$;

revoke execute on function public.finalize_completed_weeks(interval, timestamptz)
  from public, anon, authenticated;
