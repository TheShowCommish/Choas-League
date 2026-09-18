-- =====================================================================
-- 0041  Seeding and tiebreaks belong to the league
--
-- 0040 left three things hard-coded, and named the places they would
-- have to move to:
--
--   * seeding was wins desc, losses asc, points_for desc, and nothing
--     else -- no head-to-head, no way to say what a league actually
--     uses;
--   * the winners bracket re-seeded every round, whatever the league
--     wanted, while the losers bracket already had losers_reseed;
--   * a tied playoff game went to the home side, which is the better
--     seed in the winners bracket but, in a toilet bowl, the team that
--     was trying to escape last place.
--
-- Now:
--
--   seeding_tiebreakers  an ordered list, applied after wins and losses,
--                        from head_to_head, points_for, points_against,
--                        division_record and coin_flip.
--   playoff_reseed       fixed | reseed, for the winners bracket, the
--                        twin of losers_reseed.
--   playoff_tiebreak     higher_seed | bench_points | points_for, for
--                        the winners bracket.
--   losers_tiebreak      the same, for the losers bracket.
--
-- Defaults (an ESPN convert should recognise all of them):
--   seeding_tiebreakers  head_to_head, then points_for.
--   playoff_reseed       fixed -- a team keeps its place in the draw.
--                        This changes what an existing league does: the
--                        old code always re-seeded. Nothing is live, and
--                        a league that wants the old behaviour sets
--                        playoff_reseed = 'reseed'.
--   playoff_tiebreak     higher_seed, for both brackets.
--
-- Notes on the choices
-- --------------------
-- division_record is accepted and stored, and does nothing: this league
-- has no divisions yet (T-041). It sorts as a constant, so a list that
-- contains it behaves exactly as the same list without it, and starts
-- working the day divisions land. The admin screen says so.
--
-- points_against ranks the MOST points against first, the reading ESPN
-- uses: of two level teams the one that was shot at hardest has the
-- better claim. It is labelled that way in the UI so nobody guesses.
--
-- coin_flip is a coin that always lands the same way: the first 32 bits
-- of md5(league, season, team). Regenerating a bracket, or asking twice,
-- cannot change the answer, which a random() could.
--
-- There is no "split" game tiebreak. A round has to send exactly one
-- team on: both advancing breaks the field size of every later round,
-- and neither advancing ends the bracket with nobody in it. A league
-- that wants the tie itself to decide nothing uses higher_seed, which
-- is the draw deciding rather than either team.
--
-- What "higher seed" means in a toilet bowl
-- ----------------------------------------
-- The better seed goes through: the lower seed number in that bracket's
-- own seeding. In the winners bracket and in a consolation bracket that
-- is the better team, which is what ESPN does. In a toilet bowl the
-- seeding is turned over -- seed 1 is the WORST record (see
-- start_losers_bracket) -- and going through is the punishment, so the
-- top seed going through means the worse team keeps sinking. A tie is
-- never a worse team's way out.
--
-- It is the seed, not the home side. Those are the same thing in the
-- first round and under re-seeding, but a fixed bracket pairs slots:
-- the winner of 1v8 is at home against the winner of 4v5 while holding
-- the worse seed of the two, and in a fixed toilet bowl reading "home"
-- as "top seed" let the better team sink and the worse one escape.
--
-- bench_points and points_for measure which team was better, so they
-- pick the WINNER of the game and the bracket decides what winning is
-- worth. In a toilet bowl the team with the better bench escapes and
-- the other sinks, which is the same rule read from the other end.
-- Level on those too and they fall back to higher_seed.
-- =====================================================================

-- Settings ----------------------------------------------------------------
alter table public.leagues
  add column if not exists seeding_tiebreakers text[] not null
    default array['head_to_head', 'points_for'],
  add column if not exists playoff_reseed text not null default 'fixed'
    check (playoff_reseed in ('fixed', 'reseed')),
  add column if not exists playoff_tiebreak text not null default 'higher_seed'
    check (playoff_tiebreak in ('higher_seed', 'bench_points', 'points_for')),
  add column if not exists losers_tiebreak text not null default 'higher_seed'
    check (losers_tiebreak in ('higher_seed', 'bench_points', 'points_for'));

alter table public.leagues
  drop constraint if exists leagues_seeding_tiebreakers_known;
alter table public.leagues
  add constraint leagues_seeding_tiebreakers_known check (
    seeding_tiebreakers <@ array[
      'head_to_head', 'points_for', 'points_against',
      'division_record', 'coin_flip']::text[]
  );

do $note$
begin
  raise notice '0041: every league now seeds on head-to-head then points for, keeps a fixed bracket in both directions, and gives a tied playoff game to the top seed of that bracket. division_record is accepted but does nothing until divisions exist (T-041).';
end
$note$;

-- Seeding ------------------------------------------------------------------

/**
 * How each of `p_teams` did against the others, as a win percentage.
 *
 * The head-to-head tiebreaker, and the only new data the standings
 * needed: everything else is already a standings column. A three-way
 * tie is settled by each team's record inside the tie -- beat both and
 * you are 1.0, lose both and you are 0 -- which is how ESPN, Yahoo and
 * Sleeper all read it. Teams that never met, or a tie nobody won, come
 * back 0.5, so the next tiebreaker decides instead.
 *
 * Counts the same games the standings view counts: regular season, and
 * final.
 */
create or replace function public.head_to_head_win_pct(
  p_league uuid, p_teams uuid[]
) returns table (team_id uuid, win_pct numeric)
language sql
stable
security definer
set search_path = public
as $$
  with sides as (
    select m.home_team_id as team_id, m.away_team_id as opponent_id,
           m.home_score as pf, m.away_score as pa
    from public.matchups m
    where m.league_id = p_league and not m.is_playoff
      and m.status = 'final' and m.away_team_id is not null
    union all
    select m.away_team_id, m.home_team_id, m.away_score, m.home_score
    from public.matchups m
    where m.league_id = p_league and not m.is_playoff
      and m.status = 'final' and m.away_team_id is not null
  )
  select t.team_id,
         coalesce(
           sum(case when s.pf > s.pa then 1
                    when s.pf = s.pa then 0.5
                    else 0 end)
             / nullif(count(s.team_id), 0),
           0.5)
  from unnest(p_teams) as t(team_id)
  left join sides s
    on s.team_id = t.team_id
   and s.opponent_id = any(p_teams)
  group by t.team_id;
$$;

/**
 * A coin flip that always lands the same way.
 *
 * The same league, season and team always give the same number, so a
 * bracket regenerated an hour later seeds identically -- which random()
 * could not promise. A different season re-flips.
 */
create or replace function public.seeding_coin_flip(
  p_league uuid, p_season int, p_team uuid
) returns numeric
language sql
immutable
set search_path = public
as $$
  select ('x' || substr(
            md5(p_league::text || ':' || p_season::text || ':' || p_team::text),
            1, 8))::bit(32)::bigint::numeric;
$$;

/**
 * The league's teams in seed order, best first.
 *
 * Wins then losses first, as they always were. After that the league's
 * own seeding_tiebreakers, in the order it listed them, and finally the
 * team id so the answer is the same every time it is asked.
 *
 * Each tiebreaker becomes one number per team, smallest first, and the
 * numbers are compared as an array -- which is the list applied in
 * order, without any dynamic SQL. head_to_head is read inside the group
 * of teams level on wins and losses, so it means "among the teams
 * actually tied". division_record is a constant until divisions exist
 * (T-041), so listing it changes nothing.
 */
create or replace function public.league_seeding_order(p_league uuid)
returns table (team_id uuid, seed int)
language sql
stable
security definer
set search_path = public
as $$
  with league as (
    -- An empty list is a real answer: wins, losses, and then the stable
    -- arbitrary order. Only a league from before this migration, which
    -- cannot happen now the column is not null, falls back to the
    -- default.
    select l.season,
           coalesce(l.seeding_tiebreakers,
                    array['head_to_head', 'points_for']) as keys
    from public.leagues l
    where l.id = p_league
  ),
  base as (
    select st.team_id, st.wins, st.losses, st.points_for, st.points_against,
           dense_rank() over (order by st.wins desc, st.losses asc) as tier
    from public.standings st
    where st.league_id = p_league
  ),
  tiers as (
    select b.tier, array_agg(b.team_id) as teams
    from base b
    group by b.tier
  ),
  h2h as (
    select w.team_id, w.win_pct
    from tiers t
    cross join lateral public.head_to_head_win_pct(p_league, t.teams) w
  ),
  keyed as (
    select b.team_id, b.wins, b.losses,
           array(
             select case k.key
                      when 'head_to_head'   then -coalesce(h.win_pct, 0.5)
                      when 'points_for'     then -b.points_for
                      when 'points_against' then -b.points_against
                      when 'coin_flip'      then public.seeding_coin_flip(
                                                    p_league, l.season, b.team_id)
                      else 0::numeric
                    end
             from league l, unnest(l.keys) with ordinality as k(key, ord)
             order by k.ord
           ) as tiebreak_keys
    from base b
    left join h2h h on h.team_id = b.team_id
  )
  select k.team_id,
         row_number() over (
           order by k.wins desc, k.losses asc, k.tiebreak_keys, k.team_id)::int
  from keyed k;
$$;

/**
 * The same order, for the standings page.
 *
 * The standings table is where a league reads its own seeding, and the
 * line under it says who makes the playoffs -- so it has to be sorted by
 * the league's own rules, or the order and the cut line disagree with
 * the bracket that will actually be generated. It is the one caller of
 * league_seeding_order that is a member rather than an internal job, so
 * it is the one that carries the membership check; the internals stay
 * revoked, because the auto-finalize job reaches them with no user at
 * all.
 */
create or replace function public.league_standings_order(p_league uuid)
returns table (team_id uuid, seed int)
language sql
stable
security definer
set search_path = public
as $$
  select o.team_id, o.seed
  from public.league_seeding_order(p_league) o
  where public.is_league_member(p_league);
$$;

revoke execute on function public.head_to_head_win_pct(uuid, uuid[])
  from public, anon, authenticated;
revoke execute on function public.league_seeding_order(uuid)
  from public, anon, authenticated;
revoke execute on function public.seeding_coin_flip(uuid, int, uuid)
  from public, anon, authenticated;
revoke execute on function public.league_standings_order(uuid)
  from public, anon;
grant execute on function public.league_standings_order(uuid) to authenticated;

-- Game tiebreaks ------------------------------------------------------------

/**
 * What a team left on its bench over a matchup's weeks.
 *
 * Deliberately the same set the matchup screen prints under "bench
 * points" (benchOf in matchups/[matchupId]/page.tsx): every player on
 * the roster who was not in a starting slot that week. That takes in
 * three kinds of player a "join the bench slots" reading would miss and
 * the screen would not -- a player with no lineup row at all, one left
 * in a slot key the commissioner has since removed, and one on IR --
 * and the two numbers have to agree, or a commissioner reads one bench
 * total and watches the tie go the other way.
 */
create or replace function public.team_bench_points(
  p_league uuid, p_season int, p_team uuid, p_week int, p_weeks int
) returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(round(sum(coalesce(pws.points, 0)), 2), 0)
  from generate_series(
         p_week, p_week + greatest(coalesce(p_weeks, 1), 1) - 1) as w(week)
  cross join public.roster_players rp
  left join public.lineup_entries le
    on le.league_id = p_league
   and le.team_id   = p_team
   and le.season    = p_season
   and le.week      = w.week
   and le.player_id = rp.player_id
  left join public.roster_slots rs
    on rs.league_id = p_league
   and rs.slot_key  = le.slot_key
  left join public.player_week_scores pws
    on pws.league_id = p_league
   and pws.season    = p_season
   and pws.week      = w.week
   and pws.player_id = rp.player_id
  where rp.league_id = p_league
    and rp.team_id   = p_team
    and rp.dropped_at is null
    and not coalesce(rs.is_starter, false);
$$;

/**
 * The number a game tiebreak compares for one team. Higher wins the
 * game. Null for higher_seed, which compares nothing.
 */
create or replace function public.playoff_tiebreak_key(
  p_league uuid, p_season int, p_team uuid, p_week int, p_weeks int,
  p_tiebreak text
) returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select case p_tiebreak
    when 'bench_points' then
      public.team_bench_points(p_league, p_season, p_team, p_week, p_weeks)
    when 'points_for' then
      (select st.points_for from public.standings st
       where st.league_id = p_league and st.team_id = p_team)
    else null
  end;
$$;

/** Which tiebreak a bracket uses. */
create or replace function public.bracket_tiebreak(p_league uuid, p_bracket text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case when p_bracket = 'losers'
              then coalesce(l.losers_tiebreak, 'higher_seed')
              else coalesce(l.playoff_tiebreak, 'higher_seed')
         end
  from public.leagues l
  where l.id = p_league;
$$;

/**
 * Who goes through from one playoff game.
 *
 * `p_losers_advance` is the bracket's rule, not this game's: a toilet
 * bowl sends the loser on. `p_home_key` and `p_away_key` are the
 * tiebreak's measure of each side (bench points, points for), higher
 * being better; they are ignored unless the scores are level.
 *
 * `p_home_seed` and `p_away_seed` are the two teams' seeds in THIS
 * bracket (playoff_seeds.seed), which is not the same thing as the side
 * of the draw they are sitting on: a fixed bracket pairs slots, so the
 * winner of 1v8 is at home against the winner of 4v5 while holding the
 * worse seed of the two.
 *
 * A level game:
 *   higher_seed  -- the better seed goes through: the lower number in
 *                   this bracket's own seeding. In the winners bracket
 *                   and a consolation bracket that is the better team,
 *                   as ESPN does. A toilet bowl seeds the WORST record
 *                   first (see start_losers_bracket) and going through
 *                   is the punishment, so its top seed keeps sinking and
 *                   a tie is never a worse team's escape route. With a
 *                   seed missing on either side -- which only happens to
 *                   a bracket built before the seeds were written -- the
 *                   home side falls back in.
 *   bench_points / points_for
 *                -- the bigger number wins the game, and the bracket
 *                   decides whether winning means advancing. Level on
 *                   that too, and it falls back to the seed.
 *
 * Replaces playoff_game_winner (0040), which answered "who won" and so
 * handed a tied toilet bowl game to the team trying to get out of it.
 */
create or replace function public.playoff_game_advancer(
  p_home uuid, p_away uuid,
  p_home_score numeric, p_away_score numeric,
  p_losers_advance boolean, p_tiebreak text,
  p_home_key numeric, p_away_key numeric,
  p_home_seed int, p_away_seed int
) returns uuid
language sql
immutable
as $$
  select case
    when p_away is null then p_home
    when p_home_score > p_away_score then
      case when coalesce(p_losers_advance, false) then p_away else p_home end
    when p_away_score > p_home_score then
      case when coalesce(p_losers_advance, false) then p_home else p_away end
    when p_tiebreak in ('bench_points', 'points_for')
         and coalesce(p_home_key, 0) <> coalesce(p_away_key, 0) then
      case when (coalesce(p_home_key, 0) > coalesce(p_away_key, 0))
                <> coalesce(p_losers_advance, false)
           then p_home else p_away end
    when p_home_seed is not null and p_away_seed is not null
         and p_home_seed <> p_away_seed then
      case when p_home_seed < p_away_seed then p_home else p_away end
    else p_home
  end;
$$;

drop function if exists public.playoff_game_winner(uuid, uuid, numeric, numeric);

/**
 * The teams that go through from the round starting in `p_week`.
 *
 * Unchanged from 0040 except that each game is settled by
 * playoff_game_advancer under the bracket's own tiebreak, instead of
 * "the home side won a tie, now flip it if losers advance". Both sides'
 * seeds are looked up for it, because in a fixed bracket the home side
 * is the better draw slot and not necessarily the better seed.
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
    select public.playoff_game_advancer(
             m.home_team_id, m.away_team_id, m.home_score, m.away_score,
             p_losers_advance, tb.key,
             public.playoff_tiebreak_key(p_league, p_season, m.home_team_id,
                                         m.week, m.week_count, tb.key),
             public.playoff_tiebreak_key(p_league, p_season, m.away_team_id,
                                         m.week, m.week_count, tb.key),
             hs.seed, as_.seed
           ) as team_id,
           m.bracket_slot as slot
    from public.matchups m
    cross join (select public.bracket_tiebreak(p_league, p_bracket) as key) tb
    left join public.playoff_seeds hs
      on hs.league_id = p_league and hs.season = p_season
     and hs.bracket = p_bracket and hs.team_id = m.home_team_id
    left join public.playoff_seeds as_
      on as_.league_id = p_league and as_.season = p_season
     and as_.bracket = p_bracket and as_.team_id = m.away_team_id
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
 * Who is going through from each decided playoff game, for the bracket
 * screen: the "Advances" tag has to name the team the database will
 * really carry into the next round, tie or no tie.
 *
 * Members only, and only members: the one caller is the matchups page
 * under a signed-in user, so there is no service-role path to leave
 * open and no reason for anon to hold execute on it.
 */
create or replace function public.playoff_advancers_for(
  p_league uuid, p_season int
) returns table (matchup_id uuid, team_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select m.id,
         public.playoff_game_advancer(
           m.home_team_id, m.away_team_id, m.home_score, m.away_score,
           coalesce(m.bracket = 'losers' and l.losers_mode = 'toilet_bowl', false),
           public.bracket_tiebreak(p_league, m.bracket),
           public.playoff_tiebreak_key(
             p_league, p_season, m.home_team_id, m.week, m.week_count,
             public.bracket_tiebreak(p_league, m.bracket)),
           public.playoff_tiebreak_key(
             p_league, p_season, m.away_team_id, m.week, m.week_count,
             public.bracket_tiebreak(p_league, m.bracket)),
           hs.seed, as_.seed
         )
  from public.matchups m
  join public.leagues l on l.id = m.league_id
  left join public.playoff_seeds hs
    on hs.league_id = p_league and hs.season = p_season
   and hs.bracket = m.bracket and hs.team_id = m.home_team_id
  left join public.playoff_seeds as_
    on as_.league_id = p_league and as_.season = p_season
   and as_.bracket = m.bracket and as_.team_id = m.away_team_id
  where m.league_id = p_league
    and m.season = p_season
    and m.is_playoff
    and m.status = 'final'
    and public.is_league_member(p_league);
$$;

revoke execute on function public.playoff_round_advancers(uuid, int, text, int, boolean)
  from public, anon, authenticated;
revoke execute on function public.team_bench_points(uuid, int, uuid, int, int)
  from public, anon, authenticated;
revoke execute on function public.playoff_tiebreak_key(uuid, int, uuid, int, int, text)
  from public, anon, authenticated;
revoke execute on function public.bracket_tiebreak(uuid, text)
  from public, anon, authenticated;
revoke execute on function public.playoff_advancers_for(uuid, int)
  from public, anon;
grant execute on function public.playoff_advancers_for(uuid, int) to authenticated;

-- The brackets ---------------------------------------------------------------

/**
 * The teams entering the losers bracket, best first. Unchanged from
 * 0040 except that the teams which missed the playoffs are ordered by
 * the league's own seeding rules rather than by a second, hard-coded
 * copy of wins/losses/points for.
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
      select o.team_id, 2, o.seed::bigint
        from public.league_seeding_order(p_league) o
        where v_league.losers_entrants in ('non_playoff_teams', 'both')
          and not exists (
            select 1 from public.playoff_seeds s
            where s.league_id = p_league and s.season = v_league.season
              and s.bracket = 'winners' and s.team_id = o.team_id
          )
    ) x;

  return coalesce(v_result, '{}'::uuid[]);
end;
$$;

revoke execute on function public.losers_bracket_entrants(uuid)
  from public, anon, authenticated;

/**
 * Build the bracket. Unchanged from 0040 except that the seeds come
 * from league_seeding_order, which knows the league's tiebreakers.
 */
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

  select array_agg(o.team_id order by o.seed) into v_seeds
    from public.league_seeding_order(p_league) o;

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
 * Advance the playoffs. Unchanged from 0040 except that the winners
 * bracket now asks playoff_reseed whether to re-seed, the way the
 * losers bracket already asked losers_reseed. A fixed bracket in either
 * direction pairs by matchups.bracket_slot: the winner of 1v8 meets the
 * winner of 4v5, whoever they turn out to be.
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

    v_reseed := case when v_bracket = 'winners'
                     then coalesce(v_league.playoff_reseed, 'fixed') = 'reseed'
                     else coalesce(v_league.losers_reseed, 'reseed') = 'reseed'
                end;

    select array_agg(a.team_id order by a.pair_key, a.seed nulls last),
           array_agg(a.pair_key order by a.pair_key, a.seed nulls last)
      into v_teams, v_keys
      from (
        select team_id, seed,
               case when v_reseed then seed else slot end as pair_key
        from public.playoff_round_advancers(
          p_league, v_league.season, v_bracket, v_start,
          coalesce(v_bracket = 'losers'
                   and v_league.losers_mode = 'toilet_bowl', false))
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

/**
 * Whether a bracket has finished. Unchanged from 0040; re-created only
 * so the null-safe losers_advance flag reaches playoff_round_advancers.
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
      coalesce(p_bracket = 'losers'
               and v_league.losers_mode = 'toilet_bowl', false));

  return v_n <= 1;
end;
$$;

revoke execute on function public.playoff_bracket_done(uuid, text)
  from public, anon, authenticated;
grant execute on function public.generate_playoffs(uuid)     to authenticated;
grant execute on function public.advance_playoffs(uuid, int) to authenticated;
