-- =====================================================================
-- 0034  The draft room, the player pool, cities and bracket shape
--
-- Six changes, all of which the draft room needed and three of which
-- reach further than it:
--
--   The pool is fantasy positions only. Individual defenders and
--   individual offensive linemen came in from nflverse and sat in the
--   draft list two thousand deep, which is not how anybody drafts. A
--   defense is the D/ST it always was; a line is now a unit too.
--
--   An offensive line is a pseudo-player, OL_<abbr>, position 'OL' --
--   the same trick as DST_<abbr>. "NYG O-Line" is drafted, benched,
--   traded and scored down the identical code path as a receiver.
--
--   Players carry an ADP, so the board can open in the order people
--   actually draft rather than in order of last season's points.
--
--   A queued player can name the round he is wanted in, so a sleeper
--   sits in the queue through the early rounds without autopick
--   spending a first-rounder on him.
--
--   Playoff rounds say how many teams play and how many sit out, not
--   just what the round is called and how long it lasts.
--
--   Teams have a city.
--
-- The O-line stats themselves live in the catalog seed, which also owns
-- the applies_to constraint they need -- it has to, because --redo runs
-- that file ahead of this one. Re-run it afterwards:
--
--   npm run db:push -- --redo 0010
-- =====================================================================

-- ---------------------------------------------------------------------
-- Offensive lines, as pseudo-players
-- ---------------------------------------------------------------------
insert into public.nfl_players (id, full_name, position, team_abbr)
select 'OL_' || abbr, name || ' O-Line', 'OL', abbr
from public.nfl_teams
on conflict (id) do update set
  full_name = excluded.full_name,
  position  = excluded.position,
  team_abbr = excluded.team_abbr;

-- ---------------------------------------------------------------------
-- Average draft position
-- ---------------------------------------------------------------------
alter table public.nfl_players
  add column if not exists adp numeric(6,2),
  add column if not exists adp_rank int,
  add column if not exists adp_source text,
  add column if not exists adp_updated_at timestamptz;

-- Sorting the pool by ADP walks this ascending, nulls last.
create index if not exists nfl_players_adp_idx
  on public.nfl_players(adp) where adp is not null;

/**
 * Is this somebody a fantasy league would put on a roster?
 *
 * The three pseudo-players are always in. Everybody else has to hold an
 * offensive skill position or be a specialist, which is what removes
 * every individual defender and every individual offensive lineman --
 * both of which are represented by their unit instead.
 *
 * Note the check on 'OL': a real lineman can carry position 'OL' in
 * nflverse, so the position alone does not separate the unit from the
 * man. The id does.
 */
create or replace function public.is_fantasy_player(
  p_id text, p_position text
) returns boolean
language sql
immutable
as $$
  select case
    when p_id like 'DST\_%' or p_id like 'OL\_%' or p_id like 'HC\_%'
      then true
    else coalesce(p_position, '') in ('QB', 'RB', 'FB', 'WR', 'TE', 'K', 'P')
  end;
$$;

grant execute on function public.is_fantasy_player(text, text) to authenticated;

/**
 * The positions a league's flex slots accept.
 *
 * "Flex" is not a position, it is whatever this league's flex slots
 * happen to take -- which is a per-league answer, and the reason the
 * player filter has to ask the database rather than hard-code RB/WR/TE.
 * A league with no flex slot at all gets the conventional three.
 */
create or replace function public.league_flex_positions(p_league uuid)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    nullif(
      (select array_agg(distinct pos order by pos)
       from public.roster_slots rs,
            unnest(rs.eligible_positions) as pos
       where rs.league_id = p_league
         and cardinality(rs.eligible_positions) > 1
         and rs.is_starter),
      '{}'::text[]),
    array['RB', 'WR', 'TE']
  );
$$;

grant execute on function public.league_flex_positions(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- The player pool
--
-- Same shape as 0027, with three differences: it only returns players a
-- fantasy league can roster, it carries ADP, and p_position accepts the
-- pseudo-position 'FLEX', which expands to whatever this league's flex
-- slots take.
-- ---------------------------------------------------------------------
drop function if exists public.league_player_pool(
  uuid, text, text, text, text, int, int, text, text
);

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
  -- 'FLEX' is not a position anybody plays; it is this league's flex
  -- slots spelled out. Resolved once here rather than per row.
  wanted as (
    select case
      when upper(coalesce(p_position, '')) = 'FLEX'
        then public.league_flex_positions(p_league)
      when coalesce(p_position, '') = ''
        then null::text[]
      else array[p_position]
    end as positions
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
      p.adp,
      p.adp_rank,
      ng.opponent                       as next_opponent,
      ng.kickoff_at                     as next_kickoff,
      ng.is_home                        as next_is_home
    from public.nfl_players p
    cross join wanted w
    left join owned         o  on o.player_id  = p.id
    left join held          h  on h.player_id  = p.id
    left join season_totals st on st.player_id = p.id
    left join last_week     lw on lw.player_id = p.id
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

-- The position menu, now that it is a short list rather than every
-- position the NFL employs.
create or replace function public.fantasy_positions()
returns table (pos text, player_count bigint)
language sql
stable
as $$
  select p.position, count(*)
  from public.nfl_players p
  where public.is_fantasy_player(p.id, p.position)
    and p.position is not null
  group by p.position
  order by p.position;
$$;

grant execute on function public.fantasy_positions() to authenticated;

-- ---------------------------------------------------------------------
-- The draft queue gets a target round
-- ---------------------------------------------------------------------
--
-- A queue was a flat ranking, so autopick took whoever was top of it
-- regardless of when. That makes the queue unusable for the thing
-- managers most want it for: parking a round-seven target in round one
-- without risking spending the first pick on him.
--
-- target_round is the earliest round the player may be taken in. Null
-- means any round, which is what every existing row becomes.
alter table public.draft_queue
  add column if not exists target_round int check (target_round >= 1);

-- ---------------------------------------------------------------------
-- Autopick
-- ---------------------------------------------------------------------
--
-- Two changes from 0023: the queue entry has to be due (its target round
-- has arrived), and the fallback only considers players a fantasy league
-- can roster, breaking ties on ADP so a rookie with no scoring history
-- is not sorted below every deep-league bench body.
--
-- 0023's guard stays exactly as it was: any member of the league may
-- trigger an expired clock, because whoever has the room open is the one
-- who notices it run out, but a stranger may not.
create or replace function public.autopick(p_draft uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_draft   public.drafts%rowtype;
  v_pick    public.draft_picks%rowtype;
  v_player  text;
begin
  select * into v_draft from public.drafts where id = p_draft;
  if not found then return null; end if;

  if auth.uid() is not null
     and not public.is_league_member(v_draft.league_id) then
    raise exception 'That is not your draft';
  end if;

  if v_draft.status <> 'live' or not v_draft.autopick_enabled then
    return null;
  end if;
  if v_draft.pick_deadline is null or v_draft.pick_deadline > now() then
    return null;
  end if;

  select * into v_pick from public.draft_picks
    where draft_id = p_draft and pick_number = v_draft.current_pick_number;

  -- The queue, highest ranked first, skipping anybody whose round has
  -- not come round yet.
  select q.player_id into v_player
    from public.draft_queue q
    where q.team_id = v_pick.team_id
      and (q.target_round is null or q.target_round <= v_pick.round)
      and public.player_is_free(v_draft.league_id, q.player_id)
    order by q.rank
    limit 1;

  if v_player is null then
    select p.id into v_player
      from public.nfl_players p
      left join public.player_season_points sp
        on sp.player_id = p.id and sp.league_id = v_draft.league_id
      where public.is_fantasy_player(p.id, p.position)
        and public.player_is_free(v_draft.league_id, p.id)
      order by coalesce(sp.total_points, 0) desc,
               coalesce(p.adp, 9999) asc,
               p.full_name
      limit 1;
  end if;

  if v_player is null then
    return null;
  end if;

  return public.make_draft_pick(p_draft, v_player, true);
end;
$$;

-- ---------------------------------------------------------------------
-- Team cities
-- ---------------------------------------------------------------------
alter table public.teams
  add column if not exists city text not null default '';

/**
 * A city per team slot.
 *
 * Cities are handed out by slot number from a fixed list, so a
 * twelve-team league gets twelve different ones and "Team 7" is always
 * from the same place until somebody changes it. Managers edit theirs
 * on the My Team page.
 */
create or replace function public.default_team_city(p_slot int)
returns text
language sql
immutable
as $$
  select (array[
    'Chicago', 'Denver', 'Seattle', 'Austin', 'Boston', 'Miami',
    'Phoenix', 'Detroit', 'Portland', 'Nashville', 'Atlanta', 'Cleveland',
    'Baltimore', 'Minneapolis', 'San Diego', 'Pittsburgh', 'Buffalo',
    'Kansas City', 'New Orleans', 'Tampa', 'Charlotte', 'Indianapolis',
    'Milwaukee', 'Sacramento', 'Columbus', 'Memphis', 'Louisville',
    'Oklahoma City', 'Salt Lake City', 'Richmond', 'Hartford', 'Omaha'
  ])[((greatest(coalesce(p_slot, 1), 1) - 1) % 32) + 1];
$$;

grant execute on function public.default_team_city(int) to authenticated;

update public.teams
  set city = public.default_team_city(coalesce(slot_number, 1))
  where city = '';

-- ...and for every league made from now on. Replaces 0025's version.
create or replace function public.seed_league_teams()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_i int;
begin
  for v_i in 1..new.team_count loop
    insert into public.teams
      (league_id, owner_id, name, abbreviation, waiver_priority,
       slot_number, city)
    values
      (new.id, null, 'Team ' || v_i, 'T' || v_i, v_i, v_i,
       public.default_team_city(v_i))
    on conflict (league_id, name) do nothing;
  end loop;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- An offensive line is a rosterable position
-- ---------------------------------------------------------------------
insert into public.league_position_limits (league_id, position, max_count)
select l.id, 'OL', 3 from public.leagues l
on conflict (league_id, position) do nothing;

create or replace function public.seed_default_position_limits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.league_position_limits (league_id, position, max_count)
  values
    (new.id, 'QB', 4), (new.id, 'RB', 8), (new.id, 'WR', 8),
    (new.id, 'TE', 4), (new.id, 'K',  3), (new.id, 'DEF', 3),
    (new.id, 'OL', 3)
  on conflict (league_id, position) do nothing;
  return new;
end;
$$;

-- Individual defenders and linemen are no longer draftable, so a league
-- carrying a cap on them is carrying a cap on nothing.
delete from public.league_position_limits
where position in ('DL', 'LB', 'DB', 'CB', 'S', 'DE', 'DT', 'EDGE',
                   'T', 'G', 'C', 'OT', 'OG', 'LS');

-- ---------------------------------------------------------------------
-- Playoff rounds: how many teams, and how many of them sit out
-- ---------------------------------------------------------------------
--
-- 0032 let the commissioner name a round and set its length. The shape
-- was still derived: the field was whoever survived, and byes were
-- whatever it took to reach the next power of two. A commissioner who
-- wants six teams in the first round with the top two on a bye had no
-- way to say so.
--
--   teams -- how many contest the round. Null keeps the derived answer,
--            which is "everybody still standing".
--   byes  -- how many of those, top seeds first, sit the round out.
alter table public.league_playoff_rounds
  add column if not exists teams int check (teams is null or teams >= 2),
  add column if not exists byes  int not null default 0 check (byes >= 0);

/**
 * Reconcile a requested number of byes against reality.
 *
 * The teams not on a bye have to pair off evenly -- there is no such
 * thing as half a matchup -- so a request that would leave an odd field
 * has to move by one. It moves *up*: a bye is a reward promised to a top
 * seed, and taking one away is a worse surprise than handing out an
 * extra.
 *
 * The exception is a request that would put the entire field on a bye,
 * leaving a round with no games in it at all. There the extra bye is
 * taken back instead. Four teams asking for three byes get two, and one
 * game, rather than four byes and a week off for everybody.
 */
create or replace function public.playoff_round_byes(
  p_field int, p_requested int
) returns int
language sql
immutable
as $$
  select case
    when p_field <= 1 then 0
    when (p_field - b.capped) % 2 = 0 then b.capped
    when b.capped + 1 < p_field       then b.capped + 1
    else greatest(b.capped - 1, 0)
  end
  from (
    select least(greatest(coalesce(p_requested, 0), 0), greatest(p_field - 1, 0))
             as capped
  ) b;
$$;

grant execute on function public.playoff_round_byes(int, int) to authenticated;

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

  v_byes := public.playoff_round_byes(v_n, v_byes);

  for v_i in 1..((v_n - v_byes) / 2) loop
    insert into public.matchups
      (league_id, season, week, week_count, bracket,
       home_team_id, away_team_id, is_playoff, playoff_round)
    values (p_league, v_league.season, v_week, v_weeks, 'winners',
            v_seeds[v_byes + v_i], v_seeds[v_n + 1 - v_i], true,
            coalesce(nullif(v_cfg.name, ''),
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
 * As 0032, plus: the round about to be created can name its own field
 * size and its own number of byes. A field smaller than the number of
 * survivors eliminates the lowest seeds, which is how a commissioner
 * expresses "six play, then four, then two".
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
  v_byes       int;
  v_i          int;
  v_created    int := 0;
  v_round_end  int;
  v_next_week  int;
  v_next_weeks int;
  v_round      int;
  v_cfg        public.league_playoff_rounds%rowtype;
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

  select * into v_cfg from public.league_playoff_rounds
    where league_id = p_league and bracket = 'winners'
      and round_index = v_round;

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

  -- A configured field trims the lowest seeds out of the next round.
  if v_cfg.teams is not null and v_cfg.teams < v_n then
    v_n := v_cfg.teams;
    v_survivors := v_survivors[1:v_n];
  end if;

  if v_n <= 1 then
    update public.leagues set status = 'complete' where id = p_league;
    return v_created;
  end if;

  v_byes := public.playoff_round_byes(v_n, coalesce(v_cfg.byes, 0));

  for v_i in 1..((v_n - v_byes) / 2) loop
    insert into public.matchups
      (league_id, season, week, week_count, bracket,
       home_team_id, away_team_id, is_playoff, playoff_round)
    values (p_league, v_league.season, v_next_week, v_next_weeks, 'winners',
            v_survivors[v_byes + v_i], v_survivors[v_n + 1 - v_i], true,
            coalesce(nullif(v_cfg.name, ''),
                     public.playoff_round_name(v_n - v_byes)))
    on conflict (league_id, season, week, home_team_id) do nothing;
    v_created := v_created + 1;
  end loop;

  for v_i in 1..v_byes loop
    insert into public.matchups
      (league_id, season, week, week_count, bracket,
       home_team_id, away_team_id, is_playoff, playoff_round)
    values (p_league, v_league.season, v_next_week, v_next_weeks, 'winners',
            v_survivors[v_i], null, true, 'Bye')
    on conflict (league_id, season, week, home_team_id) do nothing;
    v_created := v_created + 1;
  end loop;

  update public.leagues set current_week = v_next_week where id = p_league;

  return v_created;
end;
$$;

grant execute on function public.generate_playoffs(uuid)     to authenticated;
grant execute on function public.advance_playoffs(uuid, int) to authenticated;
