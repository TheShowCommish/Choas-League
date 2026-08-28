-- =====================================================================
-- 0032  Playoffs the commissioner actually wants
--
-- The bracket was one shape: single elimination, re-seeded each round,
-- one week per round, winners only. Three things had to change.
--
--   Rounds are configured, not derived. league_playoff_rounds says how
--   many rounds there are, what each is called and how long it lasts.
--
--   A round can span two weeks. matchups.week_count says how many, and
--   the score is the sum of the team's weeks across that span. This is
--   the change that reaches furthest, because it means a matchup is no
--   longer identified by a single week.
--
--   Losers drop into a second bracket. matchups.bracket separates the
--   two, so a consolation ladder runs alongside the real thing without
--   either knowing about the other.
--
-- A league that configures nothing gets the old behaviour: one-week
-- rounds, winners only, seeded by record.
-- =====================================================================

alter table public.matchups
  add column if not exists week_count int not null default 1
    check (week_count between 1 and 4),
  add column if not exists bracket text not null default 'winners'
    check (bracket in ('winners', 'losers'));

-- The shape of a league's playoffs -------------------------------------
create table if not exists public.league_playoff_rounds (
  league_id   uuid not null references public.leagues(id) on delete cascade,
  bracket     text not null default 'winners'
              check (bracket in ('winners', 'losers')),
  -- 1 is the first round played in that bracket.
  round_index int  not null check (round_index >= 1),
  name        text not null default '',
  weeks       int  not null default 1 check (weeks between 1 and 4),
  primary key (league_id, bracket, round_index)
);

alter table public.league_playoff_rounds enable row level security;

drop policy if exists lpr_read on public.league_playoff_rounds;
create policy lpr_read on public.league_playoff_rounds
  for select to authenticated using (public.is_league_member(league_id));

drop policy if exists lpr_write on public.league_playoff_rounds;
create policy lpr_write on public.league_playoff_rounds
  for all to authenticated
  using (public.is_commissioner(league_id))
  with check (public.is_commissioner(league_id));

/**
 * How long a round lasts, and where it starts.
 *
 * Rounds are laid end to end from the league's playoff_start_week, so a
 * two-week semi-final pushes the final back a week without anybody
 * having to work that out by hand.
 */
create or replace function public.playoff_round_start(
  p_league uuid, p_bracket text, p_round int
) returns int
language sql
stable
security definer
set search_path = public
as $$
  select l.playoff_start_week + coalesce((
    select sum(r.weeks)::int
    from public.league_playoff_rounds r
    where r.league_id = p_league
      and r.bracket = p_bracket
      and r.round_index < p_round
  ), 0)
  from public.leagues l
  where l.id = p_league;
$$;

create or replace function public.playoff_round_weeks(
  p_league uuid, p_bracket text, p_round int
) returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select weeks from public.league_playoff_rounds
     where league_id = p_league and bracket = p_bracket
       and round_index = p_round),
    1
  );
$$;

grant execute on function public.playoff_round_start(uuid, text, int) to authenticated;
grant execute on function public.playoff_round_weeks(uuid, text, int) to authenticated;

-- Scores over a span of weeks -------------------------------------------
create or replace function public.team_points_over(
  p_league uuid, p_season int, p_from int, p_to int
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
    and le.week between p_from and p_to
  group by le.team_id;
$$;

grant execute on function public.team_points_over(uuid, int, int, int)
  to authenticated;

/**
 * Rescore the matchups that cover a week.
 *
 * A two-week matchup is touched by either of its weeks, and its score is
 * the sum across the whole span -- which is why this can no longer just
 * match on week = p_week.
 */
create or replace function public.recompute_matchup_scores(
  p_league uuid, p_season int, p_week int
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match record;
  v_home  numeric;
  v_away  numeric;
begin
  for v_match in
    select id, week, week_count, home_team_id, away_team_id
    from public.matchups
    where league_id = p_league
      and season = p_season
      and status <> 'final'
      and p_week between week and week + week_count - 1
  loop
    select points into v_home
      from public.team_points_over(
        p_league, p_season, v_match.week,
        v_match.week + v_match.week_count - 1)
      where team_id = v_match.home_team_id;

    select points into v_away
      from public.team_points_over(
        p_league, p_season, v_match.week,
        v_match.week + v_match.week_count - 1)
      where team_id = v_match.away_team_id;

    update public.matchups
      set home_score = coalesce(v_home, 0),
          away_score = coalesce(v_away, 0)
      where id = v_match.id;
  end loop;
end;
$$;

-- Default rounds for a league that has not configured any --------------
create or replace function public.seed_default_playoff_rounds(p_league uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_teams   int;
  v_rounds  int := 0;
  v_left    int;
begin
  select playoff_teams into v_teams from public.leagues where id = p_league;

  -- Enough single-week rounds to get from playoff_teams down to one.
  v_left := greatest(v_teams, 2);
  while v_left > 1 loop
    v_rounds := v_rounds + 1;
    v_left := ceil(v_left / 2.0);
  end loop;

  for v_left in 1..v_rounds loop
    insert into public.league_playoff_rounds
      (league_id, bracket, round_index, name, weeks)
    values (p_league, 'winners', v_left, '', 1)
    on conflict (league_id, bracket, round_index) do nothing;
  end loop;

  return v_rounds;
end;
$$;

grant execute on function public.seed_default_playoff_rounds(uuid)
  to authenticated;

-- Build the bracket ------------------------------------------------------
create or replace function public.generate_playoffs(p_league uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league   public.leagues%rowtype;
  v_seeds    uuid[];
  v_n        int;
  v_bracket  int;
  v_byes     int;
  v_i        int;
  v_created  int := 0;
  v_week     int;
  v_weeks    int;
begin
  select * into v_league from public.leagues where id = p_league;
  if not public.is_commissioner(p_league) then
    raise exception 'Only the commissioner can generate the playoffs';
  end if;

  -- A league that has never touched the settings gets the old shape.
  if not exists (
    select 1 from public.league_playoff_rounds
    where league_id = p_league and bracket = 'winners'
  ) then
    perform public.seed_default_playoff_rounds(p_league);
  end if;

  select array_agg(team_id order by wins desc, losses asc, points_for desc)
    into v_seeds
    from public.standings
    where league_id = p_league;

  v_n := least(v_league.playoff_teams, coalesce(array_length(v_seeds, 1), 0));
  if v_n < 2 then
    raise exception 'Need at least two teams to hold a playoff';
  end if;

  v_seeds := v_seeds[1:v_n];

  delete from public.playoff_seeds
    where league_id = p_league and season = v_league.season;
  delete from public.matchups
    where league_id = p_league and season = v_league.season and is_playoff;

  for v_i in 1..v_n loop
    insert into public.playoff_seeds (league_id, season, team_id, seed)
    values (p_league, v_league.season, v_seeds[v_i], v_i);
  end loop;

  v_week  := public.playoff_round_start(p_league, 'winners', 1);
  v_weeks := public.playoff_round_weeks(p_league, 'winners', 1);

  v_bracket := 2;
  while v_bracket < v_n loop
    v_bracket := v_bracket * 2;
  end loop;
  v_byes := v_bracket - v_n;

  for v_i in 1..((v_n - v_byes) / 2) loop
    insert into public.matchups
      (league_id, season, week, week_count, bracket,
       home_team_id, away_team_id, is_playoff, playoff_round)
    values (p_league, v_league.season, v_week, v_weeks, 'winners',
            v_seeds[v_byes + v_i], v_seeds[v_n + 1 - v_i], true,
            coalesce(
              nullif((select name from public.league_playoff_rounds
                      where league_id = p_league and bracket = 'winners'
                        and round_index = 1), ''),
              public.playoff_round_name(v_n - v_byes)));
    v_created := v_created + 1;
  end loop;

  for v_i in 1..v_byes loop
    insert into public.matchups
      (league_id, season, week, week_count, bracket,
       home_team_id, away_team_id, is_playoff, playoff_round)
    values (p_league, v_league.season, v_week, v_weeks, 'winners',
            v_seeds[v_i], null, true, 'Bye');
    v_created := v_created + 1;
  end loop;

  update public.leagues set status = 'playoffs' where id = p_league;

  return v_created;
end;
$$;

/**
 * Advance a bracket by one round.
 *
 * `p_week` is any week the round covers; the round is identified from
 * the matchups themselves rather than assumed to be one week long.
 *
 * Losers drop into the losers bracket when the league has configured
 * one. They are seeded among themselves the same way as the winners, so
 * the consolation ladder is a real bracket rather than a random draw.
 */
create or replace function public.advance_playoffs(p_league uuid, p_week int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league     public.leagues%rowtype;
  v_survivors  uuid[];
  v_fallen     uuid[];
  v_n          int;
  v_i          int;
  v_created    int := 0;
  v_round_end  int;
  v_next_week  int;
  v_next_weeks int;
  v_round      int;
  v_has_losers boolean;
begin
  select * into v_league from public.leagues where id = p_league;
  if not public.is_commissioner(p_league) then
    raise exception 'Only the commissioner can advance the playoffs';
  end if;

  -- The round covering this week, and the week it actually finishes on.
  select max(week + week_count - 1) into v_round_end
    from public.matchups
    where league_id = p_league and season = v_league.season
      and is_playoff and bracket = 'winners'
      and p_week between week and week + week_count - 1;

  if v_round_end is null then
    raise exception 'No playoff round covers week %', p_week;
  end if;

  if exists (
    select 1 from public.matchups
    where league_id = p_league and season = v_league.season
      and is_playoff and bracket = 'winners'
      and p_week between week and week + week_count - 1
      and status <> 'final'
  ) then
    raise exception
      'That round still has games which are not final';
  end if;

  select array_agg(t.team_id order by s.seed)
    into v_survivors
    from (
      select case
               when m.away_team_id is null then m.home_team_id
               when m.home_score >= m.away_score then m.home_team_id
               else m.away_team_id
             end as team_id
      from public.matchups m
      where m.league_id = p_league and m.season = v_league.season
        and m.is_playoff and m.bracket = 'winners'
        and p_week between m.week and m.week + m.week_count - 1
    ) t
    join public.playoff_seeds s
      on s.team_id = t.team_id
     and s.league_id = p_league
     and s.season = v_league.season;

  select array_agg(t.team_id order by s.seed)
    into v_fallen
    from (
      select case
               when m.home_score >= m.away_score then m.away_team_id
               else m.home_team_id
             end as team_id
      from public.matchups m
      where m.league_id = p_league and m.season = v_league.season
        and m.is_playoff and m.bracket = 'winners'
        and m.away_team_id is not null
        and p_week between m.week and m.week + m.week_count - 1
    ) t
    join public.playoff_seeds s
      on s.team_id = t.team_id
     and s.league_id = p_league
     and s.season = v_league.season;

  v_n := coalesce(array_length(v_survivors, 1), 0);

  -- Which round we have just finished, counting from the start.
  select count(*) + 1 into v_round
    from public.league_playoff_rounds r
    where r.league_id = p_league and r.bracket = 'winners'
      and public.playoff_round_start(p_league, 'winners', r.round_index)
          + r.weeks - 1 <= v_round_end
      and r.round_index >= 1;

  v_next_week  := v_round_end + 1;
  v_next_weeks := public.playoff_round_weeks(p_league, 'winners', v_round);

  select exists (
    select 1 from public.league_playoff_rounds
    where league_id = p_league and bracket = 'losers'
  ) into v_has_losers;

  -- The consolation ladder, from whoever just went out.
  if v_has_losers and coalesce(array_length(v_fallen, 1), 0) >= 2 then
    for v_i in 1..(array_length(v_fallen, 1) / 2) loop
      insert into public.matchups
        (league_id, season, week, week_count, bracket,
         home_team_id, away_team_id, is_playoff, playoff_round)
      values (p_league, v_league.season, v_next_week,
              public.playoff_round_weeks(p_league, 'losers', 1), 'losers',
              v_fallen[v_i],
              v_fallen[array_length(v_fallen, 1) + 1 - v_i],
              true, 'Consolation')
      on conflict (league_id, season, week, home_team_id) do nothing;
      v_created := v_created + 1;
    end loop;
  end if;

  if v_n <= 1 then
    update public.leagues set status = 'complete' where id = p_league;
    return v_created;
  end if;

  for v_i in 1..(v_n / 2) loop
    insert into public.matchups
      (league_id, season, week, week_count, bracket,
       home_team_id, away_team_id, is_playoff, playoff_round)
    values (p_league, v_league.season, v_next_week, v_next_weeks, 'winners',
            v_survivors[v_i], v_survivors[v_n + 1 - v_i], true,
            coalesce(
              nullif((select name from public.league_playoff_rounds
                      where league_id = p_league and bracket = 'winners'
                        and round_index = v_round), ''),
              public.playoff_round_name(v_n)))
    on conflict (league_id, season, week, home_team_id) do nothing;
    v_created := v_created + 1;
  end loop;

  if v_n % 2 = 1 then
    insert into public.matchups
      (league_id, season, week, week_count, bracket,
       home_team_id, away_team_id, is_playoff, playoff_round)
    values (p_league, v_league.season, v_next_week, v_next_weeks, 'winners',
            v_survivors[(v_n / 2) + 1], null, true, 'Bye')
    on conflict (league_id, season, week, home_team_id) do nothing;
    v_created := v_created + 1;
  end if;

  update public.leagues set current_week = v_next_week where id = p_league;

  return v_created;
end;
$$;

grant execute on function public.generate_playoffs(uuid)      to authenticated;
grant execute on function public.advance_playoffs(uuid, int)  to authenticated;
grant execute on function public.recompute_matchup_scores(uuid, int, int)
  to authenticated;
