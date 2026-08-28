-- =====================================================================
-- 0020  Playoffs
--
-- Seeds are frozen when the bracket is generated, because standings
-- keep moving as consolation games finish and a bracket that re-seeds
-- itself underneath you is a good way to start an argument.
--
-- Rounds re-seed: the highest remaining seed always plays the lowest.
-- With a team count that is not a power of two, the top seeds take a
-- first-round bye.
-- =====================================================================

create table if not exists public.playoff_seeds (
  league_id uuid not null references public.leagues(id) on delete cascade,
  season    int  not null,
  team_id   uuid not null references public.teams(id) on delete cascade,
  seed      int  not null,
  primary key (league_id, season, team_id),
  unique (league_id, season, seed)
);

alter table public.playoff_seeds enable row level security;

drop policy if exists playoff_seeds_read on public.playoff_seeds;
create policy playoff_seeds_read on public.playoff_seeds
  for select to authenticated using (public.is_league_member(league_id));

/**
 * Names a playoff round by how many teams are left in it.
 */
create or replace function public.playoff_round_name(p_teams int)
returns text
language sql
immutable
as $$
  select case
    when p_teams <= 2 then 'Championship'
    when p_teams <= 4 then 'Semifinal'
    when p_teams <= 8 then 'Quarterfinal'
    else 'Round of ' || p_teams
  end;
$$;

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
  v_high     uuid;
  v_low      uuid;
begin
  select * into v_league from public.leagues where id = p_league;
  if not public.is_commissioner(p_league) then
    raise exception 'Only the commissioner can generate the playoffs';
  end if;

  -- Seed by record, then points scored -- the usual tiebreak.
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

  -- Round one pairs everyone outside the byes, highest against lowest.
  v_bracket := 2;
  while v_bracket < v_n loop
    v_bracket := v_bracket * 2;
  end loop;
  v_byes := v_bracket - v_n;

  for v_i in 1..((v_n - v_byes) / 2) loop
    v_high := v_seeds[v_byes + v_i];
    v_low  := v_seeds[v_n + 1 - v_i];

    insert into public.matchups
      (league_id, season, week, home_team_id, away_team_id,
       is_playoff, playoff_round)
    values (p_league, v_league.season, v_league.playoff_start_week,
            v_high, v_low, true,
            public.playoff_round_name(v_n - v_byes));
    v_created := v_created + 1;
  end loop;

  -- A bye is a matchup with no opponent, so the team still appears.
  for v_i in 1..v_byes loop
    insert into public.matchups
      (league_id, season, week, home_team_id, away_team_id,
       is_playoff, playoff_round)
    values (p_league, v_league.season, v_league.playoff_start_week,
            v_seeds[v_i], null, true, 'Bye');
    v_created := v_created + 1;
  end loop;

  update public.leagues set status = 'playoffs' where id = p_league;

  return v_created;
end;
$$;

-- Advance the winners ----------------------------------------------------
create or replace function public.advance_playoffs(p_league uuid, p_week int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league    public.leagues%rowtype;
  v_survivors uuid[];
  v_n         int;
  v_i         int;
  v_created   int := 0;
begin
  select * into v_league from public.leagues where id = p_league;
  if not public.is_commissioner(p_league) then
    raise exception 'Only the commissioner can advance the playoffs';
  end if;

  if exists (
    select 1 from public.matchups
    where league_id = p_league and season = v_league.season
      and week = p_week and is_playoff and status <> 'final'
  ) then
    raise exception 'Week % still has playoff games that are not final', p_week;
  end if;

  -- Who is still alive: byes, plus the winner of every game played.
  -- Re-seeded highest to lowest for the next round.
  select array_agg(winners.team_id order by s.seed)
    into v_survivors
    from (
      select case
               when m.away_team_id is null then m.home_team_id
               when m.home_score >= m.away_score then m.home_team_id
               else m.away_team_id
             end as team_id
      from public.matchups m
      where m.league_id = p_league and m.season = v_league.season
        and m.week = p_week and m.is_playoff
    ) winners
    join public.playoff_seeds s
      on s.team_id = winners.team_id
     and s.league_id = p_league
     and s.season = v_league.season;

  v_n := coalesce(array_length(v_survivors, 1), 0);

  if v_n <= 1 then
    update public.leagues set status = 'complete' where id = p_league;
    return 0;
  end if;

  for v_i in 1..(v_n / 2) loop
    insert into public.matchups
      (league_id, season, week, home_team_id, away_team_id,
       is_playoff, playoff_round)
    values (p_league, v_league.season, p_week + 1,
            v_survivors[v_i], v_survivors[v_n + 1 - v_i], true,
            public.playoff_round_name(v_n))
    on conflict (league_id, season, week, home_team_id) do nothing;
    v_created := v_created + 1;
  end loop;

  -- An odd survivor count means somebody gets another bye.
  if v_n % 2 = 1 then
    insert into public.matchups
      (league_id, season, week, home_team_id, away_team_id,
       is_playoff, playoff_round)
    values (p_league, v_league.season, p_week + 1,
            v_survivors[(v_n / 2) + 1], null, true, 'Bye')
    on conflict (league_id, season, week, home_team_id) do nothing;
    v_created := v_created + 1;
  end if;

  update public.leagues set current_week = p_week + 1 where id = p_league;

  return v_created;
end;
$$;

grant execute on function public.generate_playoffs(uuid)      to authenticated;
grant execute on function public.advance_playoffs(uuid, int)  to authenticated;
grant execute on function public.playoff_round_name(int)      to authenticated;
