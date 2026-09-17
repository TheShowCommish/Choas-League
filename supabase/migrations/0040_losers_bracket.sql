-- =====================================================================
-- 0040  The losers bracket is a real bracket
--
-- 0032 promised a losers bracket that ran alongside the winners one.
-- What advance_playoffs actually did was pair up whoever had just lost
-- in the winners bracket, call every game "Consolation", and never look
-- at those games again. Its configured rounds were read for one thing:
-- the length of round one. Teams that missed the playoffs could never
-- enter, and the league was marked complete as soon as the final was
-- decided, with consolation games still open (and, since 0038 only
-- finalizes leagues in season or in the playoffs, stuck open for good).
--
-- Now every league chooses, and nothing is assumed:
--
--   losers_bracket_enabled  on or off.
--   losers_entrants         eliminated_playoff_teams | non_playoff_teams | both.
--   losers_mode             consolation (winners advance; the last team
--                           standing is the best of the rest) or
--                           toilet_bowl (losers advance; the last team
--                           standing finishes last).
--   losers_reseed           fixed (a team keeps its place in the draw) or
--                           reseed (best remaining seed plays the worst).
--   losers_start_week       the losers bracket's own first week.
--
-- The losers bracket plays its own league_playoff_rounds rows -- weeks,
-- teams, byes and name per round -- and advances round by round exactly
-- as the winners bracket does, because both now go through the same
-- two functions: playoff_round_advancers (who goes through) and
-- playoff_create_round (lay out the next round). The winners bracket
-- keeps its behaviour: it re-seeds every round, and the home side wins
-- a tie. Seeding and tiebreak settings are T-010; the places they plug
-- in are playoff_game_winner, losers_bracket_entrants and the reseed
-- flag in advance_playoffs.
--
-- The league is complete when BOTH brackets are done.
--
-- Mapping existing leagues
-- ------------------------
-- A league with losers rounds configured had, in effect: entrants =
-- teams knocked out of the playoffs, winners advancing (the games were
-- called consolation), seeds re-sorted every time, and the first losers
-- games the week after winners round one. It keeps exactly that as its
-- stored settings. Every other league is stored as disabled, with no
-- entrants, mode or seeding chosen: a commissioner turning the losers
-- bracket on has to pick them.
-- =====================================================================

-- Settings ----------------------------------------------------------------
alter table public.leagues
  add column if not exists losers_bracket_enabled boolean not null default false,
  add column if not exists losers_entrants text
    check (losers_entrants in ('eliminated_playoff_teams', 'non_playoff_teams', 'both')),
  add column if not exists losers_mode text
    check (losers_mode in ('consolation', 'toilet_bowl')),
  add column if not exists losers_reseed text
    check (losers_reseed in ('fixed', 'reseed')),
  add column if not exists losers_start_week int
    check (losers_start_week >= 1);

-- An enabled losers bracket has made every choice.
alter table public.leagues
  drop constraint if exists leagues_losers_bracket_chosen;
alter table public.leagues
  add constraint leagues_losers_bracket_chosen check (
    not losers_bracket_enabled
    or (losers_entrants is not null
        and losers_mode is not null
        and losers_reseed is not null
        and losers_start_week is not null)
  );

do $map$
declare
  v_mapped int;
begin
  update public.leagues l
    set losers_bracket_enabled = true,
        losers_entrants   = 'eliminated_playoff_teams',
        losers_mode       = 'consolation',
        losers_reseed     = 'reseed',
        losers_start_week = l.playoff_start_week + coalesce((
          select r.weeks from public.league_playoff_rounds r
          where r.league_id = l.id and r.bracket = 'winners'
            and r.round_index = 1), 1)
    where l.losers_entrants is null
      and exists (
        select 1 from public.league_playoff_rounds r
        where r.league_id = l.id and r.bracket = 'losers'
      );
  get diagnostics v_mapped = row_count;

  raise notice
    '0040: % league(s) with losers rounds mapped to enabled, eliminated_playoff_teams, consolation, reseed, starting the week after winners round 1; all others disabled.',
    v_mapped;
end
$map$;

-- A team can be seeded in both brackets ------------------------------------
alter table public.playoff_seeds
  add column if not exists bracket text not null default 'winners'
    check (bracket in ('winners', 'losers'));

alter table public.playoff_seeds
  drop constraint if exists playoff_seeds_league_id_season_seed_key;
alter table public.playoff_seeds
  drop constraint if exists playoff_seeds_league_id_season_bracket_seed_key;
alter table public.playoff_seeds
  add constraint playoff_seeds_league_id_season_bracket_seed_key
  unique (league_id, season, bracket, seed);

alter table public.playoff_seeds drop constraint if exists playoff_seeds_pkey;
alter table public.playoff_seeds
  add constraint playoff_seeds_pkey primary key (league_id, season, bracket, team_id);

-- Where a game sits in the draw ---------------------------------------------
--
-- A fixed bracket pairs games, not teams: the winner of 1v8 meets the
-- winner of 4v5 whoever they turn out to be. Each game carries the best
-- seed that could come out of its half of the draw, and whoever goes
-- through inherits it. Round one's slot is the home seed.
alter table public.matchups
  add column if not exists bracket_slot int;

-- Where a round starts -------------------------------------------------------
create or replace function public.playoff_round_start(
  p_league uuid, p_bracket text, p_round int
) returns int
language sql
stable
security definer
set search_path = public
as $$
  select case when p_bracket = 'losers'
              then coalesce(l.losers_start_week, l.playoff_start_week)
              else l.playoff_start_week
         end
       + coalesce((
           select sum(r.weeks)::int
           from public.league_playoff_rounds r
           where r.league_id = p_league
             and r.bracket = p_bracket
             and r.round_index < p_round
         ), 0)
  from public.leagues l
  where l.id = p_league;
$$;

/**
 * A losers bracket round with no name of its own.
 *
 * Named for the mode, so a toilet bowl does not read as a consolation
 * ladder: "Consolation Round 1" ... "Consolation Final", or
 * "Toilet Bowl Round 1" ... "Toilet Bowl Final".
 */
create or replace function public.losers_round_name(
  p_mode text, p_round int, p_field int, p_byes int
) returns text
language sql
immutable
as $$
  select case when p_mode = 'toilet_bowl' then 'Toilet Bowl' else 'Consolation' end
      || case when p_field - p_byes = 2 and p_byes = 0
              then ' Final'
              else ' Round ' || p_round
         end;
$$;

grant execute on function public.losers_round_name(text, int, int, int) to authenticated;

/**
 * Who won a playoff game. The home side (the better seed) takes a tie.
 *
 * One place, so a league's own tiebreak (T-010) has one place to go.
 */
create or replace function public.playoff_game_winner(
  p_home uuid, p_away uuid, p_home_score numeric, p_away_score numeric
) returns uuid
language sql
immutable
as $$
  select case
    when p_away is null then p_home
    when p_home_score >= p_away_score then p_home
    else p_away
  end;
$$;

/**
 * The teams that go through from the round starting in `p_week`.
 *
 * Byes always go through. From each game, the winner does -- or, when
 * `p_losers_advance`, the loser. `slot` is the place in the draw they
 * inherit (see matchups.bracket_slot); `seed` is their own seed in this
 * bracket.
 */
create or replace function public.playoff_round_advancers(
  p_league uuid, p_season int, p_bracket text, p_week int,
  p_losers_advance boolean
) returns table (team_id uuid, slot int, seed int)
language sql
stable
security definer
set search_path = public
as $$
  select t.team_id, coalesce(t.slot, s.seed), s.seed
  from (
    select case
             when m.away_team_id is null then m.home_team_id
             when (public.playoff_game_winner(m.home_team_id, m.away_team_id,
                                              m.home_score, m.away_score)
                   = m.home_team_id) <> p_losers_advance
               then m.home_team_id
             else m.away_team_id
           end as team_id,
           m.bracket_slot as slot
    from public.matchups m
    where m.league_id = p_league
      and m.season = p_season
      and m.is_playoff
      and m.bracket = p_bracket
      and m.week = p_week
  ) t
  left join public.playoff_seeds s
    on s.league_id = p_league
   and s.season = p_season
   and s.bracket = p_bracket
   and s.team_id = t.team_id;
$$;

/**
 * Lay out one round of a bracket.
 *
 * `p_teams` is the field in pairing order and `p_keys` the matching
 * seed (or draw slot) of each. A configured field smaller than that
 * drops the tail. The top `p_byes` (null = the round's configured byes,
 * settled so the rest pair off) sit out; the rest play first against
 * last. Weeks and name come from the round's own configuration.
 *
 * Internal: callers do their own authorisation.
 */
create or replace function public.playoff_create_round(
  p_league uuid, p_season int, p_bracket text, p_round int, p_week int,
  p_teams uuid[], p_keys int[], p_byes int
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg     public.league_playoff_rounds%rowtype;
  v_mode    text;
  v_n       int := coalesce(array_length(p_teams, 1), 0);
  v_byes    int;
  v_weeks   int;
  v_name    text;
  v_i       int;
  v_created int := 0;
begin
  select * into v_cfg from public.league_playoff_rounds
    where league_id = p_league and bracket = p_bracket
      and round_index = p_round;

  if v_cfg.teams is not null and v_cfg.teams < v_n then
    v_n := v_cfg.teams;
  end if;

  if v_n < 2 then
    return 0;
  end if;

  v_byes  := public.playoff_round_byes(v_n, coalesce(p_byes, v_cfg.byes, 0));
  v_weeks := coalesce(v_cfg.weeks, 1);

  if p_bracket = 'winners' then
    v_name := coalesce(nullif(v_cfg.name, ''),
                       public.playoff_round_name(v_n - v_byes));
  else
    select losers_mode into v_mode from public.leagues where id = p_league;
    v_name := coalesce(nullif(v_cfg.name, ''),
                       public.losers_round_name(v_mode, p_round, v_n, v_byes));
  end if;

  for v_i in 1..((v_n - v_byes) / 2) loop
    insert into public.matchups
      (league_id, season, week, week_count, bracket,
       home_team_id, away_team_id, is_playoff, playoff_round, bracket_slot)
    values (p_league, p_season, p_week, v_weeks, p_bracket,
            p_teams[v_byes + v_i], p_teams[v_n + 1 - v_i], true, v_name,
            p_keys[v_byes + v_i])
    on conflict (league_id, season, week, home_team_id) do nothing;
    v_created := v_created + 1;
  end loop;

  for v_i in 1..v_byes loop
    insert into public.matchups
      (league_id, season, week, week_count, bracket,
       home_team_id, away_team_id, is_playoff, playoff_round, bracket_slot)
    values (p_league, p_season, p_week, v_weeks, p_bracket,
            p_teams[v_i], null, true, 'Bye', p_keys[v_i])
    on conflict (league_id, season, week, home_team_id) do nothing;
    v_created := v_created + 1;
  end loop;

  return v_created;
end;
$$;

revoke execute on function public.playoff_create_round(uuid, int, text, int, int, uuid[], int[], int)
  from public, anon, authenticated;
revoke execute on function public.playoff_round_advancers(uuid, int, text, int, boolean)
  from public, anon, authenticated;

/**
 * The teams entering the losers bracket, best first. Null while that
 * cannot be known yet.
 *
 * Knocked-out playoff teams are those no longer in the winners bracket
 * by losers_start_week: everyone missing from the first winners round
 * that starts on or after it, or, if the winners bracket finishes
 * before then, everyone but the champion. Until that round exists (or
 * the final is decided) the answer is null.
 *
 * Order: knocked-out teams by playoff seed, then teams that missed the
 * playoffs by regular season record -- which, since the seeds were
 * taken from that same record, is the regular season order throughout.
 */
create or replace function public.losers_bracket_entrants(p_league uuid)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_league public.leagues%rowtype;
  v_week   int;
  v_alive  uuid[];
  v_result uuid[];
begin
  select * into v_league from public.leagues where id = p_league;

  if not coalesce(v_league.losers_bracket_enabled, false) then
    return null;
  end if;

  if not exists (
    select 1 from public.playoff_seeds
    where league_id = p_league and season = v_league.season
      and bracket = 'winners'
  ) then
    return null;
  end if;

  if v_league.losers_entrants in ('eliminated_playoff_teams', 'both') then
    select min(week) into v_week
      from public.matchups
      where league_id = p_league and season = v_league.season
        and is_playoff and bracket = 'winners'
        and week >= v_league.losers_start_week;

    if v_week is not null then
      select array_agg(t) into v_alive
        from public.matchups m,
             lateral unnest(array[m.home_team_id, m.away_team_id]) as t
        where m.league_id = p_league and m.season = v_league.season
          and m.is_playoff and m.bracket = 'winners' and m.week = v_week
          and t is not null;
    else
      -- Nothing starts that late: the winners bracket has to be over.
      select max(week) into v_week
        from public.matchups
        where league_id = p_league and season = v_league.season
          and is_playoff and bracket = 'winners';

      if v_week is null or exists (
        select 1 from public.matchups
        where league_id = p_league and season = v_league.season
          and is_playoff and bracket = 'winners' and week = v_week
          and status <> 'final'
      ) then
        return null;
      end if;

      select array_agg(a.team_id) into v_alive
        from public.playoff_round_advancers(
          p_league, v_league.season, 'winners', v_week, false) a;

      if coalesce(array_length(v_alive, 1), 0) > 1 then
        return null;
      end if;
    end if;
  end if;

  select array_agg(x.team_id order by x.grp, x.ord) into v_result
    from (
      select s.team_id, 1 as grp, s.seed::bigint as ord
        from public.playoff_seeds s
        where s.league_id = p_league and s.season = v_league.season
          and s.bracket = 'winners'
          and v_league.losers_entrants in ('eliminated_playoff_teams', 'both')
          and not (s.team_id = any(coalesce(v_alive, '{}'::uuid[])))
      union all
      select st.team_id, 2,
             row_number() over (
               order by st.wins desc, st.losses asc, st.points_for desc,
                        st.team_id)
        from public.standings st
        where st.league_id = p_league
          and v_league.losers_entrants in ('non_playoff_teams', 'both')
          and not exists (
            select 1 from public.playoff_seeds s
            where s.league_id = p_league and s.season = v_league.season
              and s.bracket = 'winners' and s.team_id = st.team_id
          )
    ) x;

  return coalesce(v_result, '{}'::uuid[]);
end;
$$;

revoke execute on function public.losers_bracket_entrants(uuid)
  from public, anon, authenticated;

/**
 * Seed and lay out the losers bracket's first round, once its entrants
 * are known. Does nothing if it is off, already started, not yet
 * decidable, or would have fewer than two teams.
 *
 * In a toilet bowl the order is turned over: the worst record is the
 * top seed, so it takes any bye (which, when losers advance, moves it a
 * round closer to last place) and plays the best of the entrants.
 *
 * Internal: callers do their own authorisation.
 */
create or replace function public.start_losers_bracket(p_league uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league   public.leagues%rowtype;
  v_entrants uuid[];
  v_cfg      public.league_playoff_rounds%rowtype;
  v_n        int;
  v_i        int;
begin
  select * into v_league from public.leagues where id = p_league;

  if not coalesce(v_league.losers_bracket_enabled, false) then
    return 0;
  end if;

  if exists (
    select 1 from public.matchups
    where league_id = p_league and season = v_league.season
      and is_playoff and bracket = 'losers'
  ) then
    return 0;
  end if;

  v_entrants := public.losers_bracket_entrants(p_league);
  if v_entrants is null then
    return 0;
  end if;

  if v_league.losers_mode = 'toilet_bowl' then
    v_entrants := array(
      select e from unnest(v_entrants) with ordinality as u(e, i)
      order by i desc
    );
  end if;

  select * into v_cfg from public.league_playoff_rounds
    where league_id = p_league and bracket = 'losers' and round_index = 1;

  v_n := coalesce(array_length(v_entrants, 1), 0);
  if v_cfg.teams is not null then
    v_n := least(v_n, v_cfg.teams);
  end if;

  if v_n < 2 then
    return 0;
  end if;

  v_entrants := v_entrants[1:v_n];

  delete from public.playoff_seeds
    where league_id = p_league and season = v_league.season
      and bracket = 'losers';

  for v_i in 1..v_n loop
    insert into public.playoff_seeds (league_id, season, bracket, team_id, seed)
    values (p_league, v_league.season, 'losers', v_entrants[v_i], v_i);
  end loop;

  return public.playoff_create_round(
    p_league, v_league.season, 'losers', 1, v_league.losers_start_week,
    v_entrants, array(select generate_series(1, v_n)), coalesce(v_cfg.byes, 0));
end;
$$;

revoke execute on function public.start_losers_bracket(uuid)
  from public, anon, authenticated;

/**
 * Whether a bracket has finished: its latest round is final and at most
 * one team went through. A losers bracket that is switched off is
 * finished; one that could never have two entrants is finished too,
 * rather than holding the season open forever.
 */
create or replace function public.playoff_bracket_done(
  p_league uuid, p_bracket text
) returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_league   public.leagues%rowtype;
  v_week     int;
  v_entrants uuid[];
  v_teams    int;
  v_n        int;
begin
  select * into v_league from public.leagues where id = p_league;

  -- Switched off before it started: nothing to wait for. Switched off
  -- after its games exist, those games still have to finish, or the
  -- league completes around them and they are never finalized.
  if p_bracket = 'losers'
     and not coalesce(v_league.losers_bracket_enabled, false)
     and not exists (
       select 1 from public.matchups
       where league_id = p_league and season = v_league.season
         and is_playoff and bracket = 'losers'
     ) then
    return true;
  end if;

  select max(week) into v_week
    from public.matchups
    where league_id = p_league and season = v_league.season
      and is_playoff and bracket = p_bracket;

  if v_week is null then
    if p_bracket = 'winners' then
      return false;
    end if;

    v_entrants := public.losers_bracket_entrants(p_league);
    if v_entrants is null then
      return false;
    end if;

    select teams into v_teams from public.league_playoff_rounds
      where league_id = p_league and bracket = 'losers' and round_index = 1;

    return least(coalesce(array_length(v_entrants, 1), 0),
                 coalesce(v_teams, 2147483647)) < 2;
  end if;

  if exists (
    select 1 from public.matchups
    where league_id = p_league and season = v_league.season
      and is_playoff and bracket = p_bracket and week = v_week
      and status <> 'final'
  ) then
    return false;
  end if;

  select count(*) into v_n
    from public.playoff_round_advancers(
      p_league, v_league.season, p_bracket, v_week,
      p_bracket = 'losers' and v_league.losers_mode = 'toilet_bowl');

  return v_n <= 1;
end;
$$;

revoke execute on function public.playoff_bracket_done(uuid, text)
  from public, anon, authenticated;

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
  v_cfg      public.league_playoff_rounds%rowtype;
  v_i        int;
  v_created  int := 0;
begin
  select * into v_league from public.leagues where id = p_league;
  if not public.is_commissioner(p_league) then
    raise exception 'Only the commissioner can generate the playoffs';
  end if;

  -- The save actions refuse this; a losers bracket starting in the
  -- regular season would collide with its matchups and lose games.
  if v_league.losers_bracket_enabled
     and v_league.losers_start_week < v_league.playoff_start_week then
    raise exception
      'The losers bracket starts in week %, before the playoffs start in week %',
      v_league.losers_start_week, v_league.playoff_start_week;
  end if;

  -- A league that has never touched the settings gets the old shape.
  if not exists (
    select 1 from public.league_playoff_rounds
    where league_id = p_league and bracket = 'winners'
  ) then
    perform public.seed_default_playoff_rounds(p_league);
  end if;

  select * into v_cfg from public.league_playoff_rounds
    where league_id = p_league and bracket = 'winners' and round_index = 1;

  select array_agg(team_id order by wins desc, losses asc, points_for desc)
    into v_seeds
    from public.standings
    where league_id = p_league;

  v_n := least(v_league.playoff_teams, coalesce(array_length(v_seeds, 1), 0));
  -- A configured field size caps the bracket; it never invents teams the
  -- league does not have.
  if v_cfg.teams is not null then
    v_n := least(v_n, v_cfg.teams);
  end if;

  if v_n < 2 then
    raise exception 'Need at least two teams to hold a playoff';
  end if;

  v_seeds := v_seeds[1:v_n];

  -- Both brackets go: a regenerated bracket starts from nothing.
  delete from public.playoff_seeds
    where league_id = p_league and season = v_league.season;
  delete from public.matchups
    where league_id = p_league and season = v_league.season and is_playoff;

  for v_i in 1..v_n loop
    insert into public.playoff_seeds (league_id, season, bracket, team_id, seed)
    values (p_league, v_league.season, 'winners', v_seeds[v_i], v_i);
  end loop;

  -- Configured byes win. With none set, fall back to whatever it takes
  -- to reach the next power of two, which is what 0032 always did.
  if v_cfg.round_index is null or coalesce(v_cfg.byes, 0) = 0 then
    v_bracket := 2;
    while v_bracket < v_n loop
      v_bracket := v_bracket * 2;
    end loop;
    v_byes := v_bracket - v_n;
  else
    v_byes := v_cfg.byes;
  end if;

  v_created := public.playoff_create_round(
    p_league, v_league.season, 'winners', 1,
    public.playoff_round_start(p_league, 'winners', 1),
    v_seeds, array(select generate_series(1, v_n)), v_byes);

  update public.leagues set status = 'playoffs' where id = p_league;

  -- A losers bracket of teams that missed the playoffs can start now.
  v_created := v_created + public.start_losers_bracket(p_league);

  return v_created;
end;
$$;

/**
 * Advance the playoffs.
 *
 * Each bracket's latest round that has started by `p_week` and is fully
 * final gets its next round, starting the week after it ends. The
 * winners bracket always re-seeds; the losers bracket re-seeds or keeps
 * its draw as the league chose, and sends its winners or its losers
 * through. Rounds use their own configured weeks, field, byes and name.
 *
 * Then the losers bracket starts, if its entrants have just become
 * known. The league is complete once both brackets are finished.
 *
 * Returns how many matchups were created. Raises if nothing could move
 * because a round is unfinished, or no round has started by `p_week`.
 */
create or replace function public.advance_playoffs(p_league uuid, p_week int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league    public.leagues%rowtype;
  v_bracket   text;
  v_start     int;
  v_end       int;
  v_round     int;
  v_reseed    boolean;
  v_teams     uuid[];
  v_keys      int[];
  v_n         int;
  v_next      int;
  v_created   int := 0;
  v_seen      boolean := false;
  v_blocked   boolean := false;
begin
  select * into v_league from public.leagues where id = p_league;
  if not public.is_commissioner(p_league) then
    raise exception 'Only the commissioner can advance the playoffs';
  end if;

  foreach v_bracket in array array['winners', 'losers'] loop
    -- The bracket's latest round, identified by the week it starts.
    select max(week) into v_start
      from public.matchups
      where league_id = p_league and season = v_league.season
        and is_playoff and bracket = v_bracket;

    continue when v_start is null or v_start > p_week;
    v_seen := true;

    if exists (
      select 1 from public.matchups
      where league_id = p_league and season = v_league.season
        and is_playoff and bracket = v_bracket and week = v_start
        and status <> 'final'
    ) then
      v_blocked := true;
      continue;
    end if;

    select max(week + week_count - 1) into v_end
      from public.matchups
      where league_id = p_league and season = v_league.season
        and is_playoff and bracket = v_bracket and week = v_start;

    -- The winners bracket always re-seeds (a setting in T-010).
    v_reseed := v_bracket = 'winners'
                or coalesce(v_league.losers_reseed, 'reseed') = 'reseed';

    select array_agg(a.team_id order by a.pair_key, a.seed nulls last),
           array_agg(a.pair_key order by a.pair_key, a.seed nulls last)
      into v_teams, v_keys
      from (
        select team_id, seed,
               case when v_reseed then seed else slot end as pair_key
        from public.playoff_round_advancers(
          p_league, v_league.season, v_bracket, v_start,
          v_bracket = 'losers' and v_league.losers_mode = 'toilet_bowl')
      ) a;

    v_n := coalesce(array_length(v_teams, 1), 0);
    continue when v_n <= 1;

    select count(distinct week) + 1 into v_round
      from public.matchups
      where league_id = p_league and season = v_league.season
        and is_playoff and bracket = v_bracket;

    v_n := public.playoff_create_round(
      p_league, v_league.season, v_bracket, v_round, v_end + 1,
      v_teams, v_keys, null);

    if v_n > 0 then
      v_created := v_created + v_n;
      v_next := least(coalesce(v_next, v_end + 1), v_end + 1);
    end if;
  end loop;

  v_n := public.start_losers_bracket(p_league);
  if v_n > 0 then
    v_created := v_created + v_n;
    v_next := least(coalesce(v_next, v_league.losers_start_week),
                    v_league.losers_start_week);
  end if;

  if v_created = 0 then
    if v_blocked then
      raise exception 'That round still has games which are not final';
    end if;
    if not v_seen then
      raise exception 'No playoff round covers week %', p_week;
    end if;
  end if;

  if public.playoff_bracket_done(p_league, 'winners')
     and public.playoff_bracket_done(p_league, 'losers') then
    update public.leagues set status = 'complete' where id = p_league;
  elsif v_next is not null then
    update public.leagues
      set current_week = greatest(current_week, v_next)
      where id = p_league;
  end if;

  return v_created;
end;
$$;

grant execute on function public.generate_playoffs(uuid)     to authenticated;
grant execute on function public.advance_playoffs(uuid, int) to authenticated;
