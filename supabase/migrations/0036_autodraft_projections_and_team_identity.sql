-- =====================================================================
-- 0036  Autodraft strategies, season projections, injuries, team colours
--
-- Five changes, four of which the draft room asked for:
--
--   Every manager picks their own autodraft logic. The queue was the
--   only way to influence autopick, and once it emptied everybody got
--   the same fallback -- last season's points. A manager who wants the
--   best available by ADP, or by what this year is projected to bring,
--   now says so and autopick obeys.
--
--   Autopick's choice is a function anybody can ask, rather than
--   something only discoverable by letting the clock run out. The room
--   shows the manager on the clock exactly who is about to be taken.
--
--   A projection for the whole season, stored as a stat line like the
--   weekly one, so it is scored with the league's own rules.
--
--   Injuries live on the player rather than only inside a weekly
--   projection row: what is hurt, how it reads, and when it was last
--   confirmed.
--
--   Teams get a second colour, so a team page can be themed rather than
--   just accented.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Team identity: a second colour, and an autodraft strategy
-- ---------------------------------------------------------------------
alter table public.teams
  add column if not exists secondary_color text not null default '#f59e0b'
    check (secondary_color ~ '^#[0-9a-fA-F]{6}$');

-- How autopick chooses once the queue has nothing due.
--
--   adp         -- the order the room is drafting in
--   last_season -- what the player actually scored last year
--   projection  -- what this season is projected to bring, in this
--                  league's scoring
alter table public.teams
  add column if not exists autodraft_strategy text not null default 'adp'
    check (autodraft_strategy in ('adp', 'last_season', 'projection'));

-- ---------------------------------------------------------------------
-- Injuries, on the player
-- ---------------------------------------------------------------------
--
-- player_week_projections already carried an injury_status, but it is
-- the wrong home for it: it only exists for a week somebody has
-- projected, it says nothing about what is hurt, and it disappears the
-- moment the week rolls over. These columns are the player's current
-- condition, refreshed by the injury job.
alter table public.nfl_players
  add column if not exists injury_status text,
  add column if not exists injury_body_part text,
  add column if not exists injury_notes text,
  add column if not exists injury_start_date date,
  add column if not exists practice_participation text,
  add column if not exists injury_updated_at timestamptz;

-- ---------------------------------------------------------------------
-- Season projections
-- ---------------------------------------------------------------------
--
-- Same reasoning as 0028's weekly table: a stat line, not a points
-- total, because points depend on the league's rules. One row per
-- player per season.
create table if not exists public.player_season_projections (
  player_id  text not null references public.nfl_players(id) on delete cascade,
  season     int  not null,
  stats      jsonb not null default '{}'::jsonb,
  /* What the source itself said, under its own scoring. Kept only so a
     season with no league rules yet still has something to sort by. */
  source_points numeric,
  source     text not null default 'sleeper',
  updated_at timestamptz not null default now(),
  primary key (player_id, season)
);

create index if not exists psp_season_idx
  on public.player_season_projections(season);

alter table public.player_season_projections enable row level security;

drop policy if exists psp_read on public.player_season_projections;
create policy psp_read on public.player_season_projections
  for select to authenticated using (true);

/**
 * A whole season's projection, scored with one league's rules.
 *
 * Deliberately the same shape as projected_points in 0028, over the
 * season table instead of the weekly one.
 *
 * The membership guard is lenient about a caller with no identity at
 * all: the ingestion jobs and a direct psql session set no JWT claims,
 * and neither is a browser trying to read somebody else's league.
 */
create or replace function public.league_season_projection(
  p_league uuid, p_season int
) returns table (player_id text, points numeric)
language sql
stable
security definer
set search_path = public
as $$
  select psp.player_id,
         round(coalesce(sum(public.safe_numeric(kv.value) * r.points), 0), 2)
  from public.player_season_projections psp
  join public.nfl_players pl on pl.id = psp.player_id
  cross join lateral jsonb_each_text(psp.stats) as kv(key, value)
  join public.league_scoring_rules r
    on r.league_id = p_league
   and r.stat_key  = kv.key
   and r.points   <> 0
   and (cardinality(r.positions) = 0 or pl.position = any(r.positions))
  where psp.season = p_season
    and (auth.uid() is null or public.is_league_member(p_league))
  group by psp.player_id;
$$;

grant execute on function public.league_season_projection(uuid, int)
  to authenticated;

-- ---------------------------------------------------------------------
-- ADP: clear everything the jobs wrote, whatever wrote it
-- ---------------------------------------------------------------------
--
-- 0035 cleared only rows sourced from ESPN, which was right while ESPN
-- was the only source. It no longer is -- mock-draft ADP comes from
-- Fantasy Football Calculator -- and a source-by-source list is a thing
-- somebody will forget to extend. Nothing but these jobs ever writes
-- ADP, so clearing all of it is both correct and future-proof.
create or replace function public.set_player_adp(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_set  int;
begin
  v_role := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role',
    'service_role'
  );

  if v_role <> 'service_role' then
    raise exception 'Only the ingestion jobs can set ADP';
  end if;

  update public.nfl_players
     set adp = null, adp_rank = null
   where adp is not null;

  update public.nfl_players p
     set adp            = (r.value->>'adp')::numeric,
         adp_rank       = (r.value->>'adp_rank')::int,
         adp_source     = r.value->>'adp_source',
         adp_updated_at = now()
    from jsonb_array_elements(p_rows) as r
   where p.id = r.value->>'id';

  get diagnostics v_set = row_count;
  return v_set;
end;
$$;

-- ---------------------------------------------------------------------
-- The player pool, now carrying a projection and an injury
-- ---------------------------------------------------------------------
--
-- Three additions to 0034's version: proj_points (this season's
-- projection under this league's rules), the player's injury, and
-- 'projection' as a sort key. Adding columns to the result means the
-- function has to be dropped rather than replaced.
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
  proj_points      numeric,
  injury_status    text,
  injury_body_part text,
  bye_week         int,
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
  -- This season's projection, scored with this league's rules. Inlined
  -- rather than calling league_season_projection so the planner sees one
  -- query rather than a definer function per pool read.
  projection as (
    select psp.player_id,
           round(coalesce(sum(public.safe_numeric(kv.value) * r.points), 0), 2)
             as points
    from public.player_season_projections psp
    join public.nfl_players pl on pl.id = psp.player_id
    cross join league l
    cross join lateral jsonb_each_text(psp.stats) as kv(key, value)
    join public.league_scoring_rules r
      on r.league_id = p_league
     and r.stat_key  = kv.key
     and r.points   <> 0
     and (cardinality(r.positions) = 0 or pl.position = any(r.positions))
    where psp.season = l.season
    group by psp.player_id
  ),
  last_week as (
    select pws.player_id, pws.points
    from public.player_week_scores pws, league l
    where pws.league_id = p_league
      and pws.season = l.season
      and pws.week = greatest(l.current_week - 1, 1)
  ),
  -- The one week in the regular season an NFL team does not play.
  --
  -- Derived from the schedule rather than stored, so it cannot go
  -- stale, and only over the weeks the schedule actually holds -- a
  -- half-loaded season would otherwise report week 1 as everybody's bye.
  played as (
    select g.home_team as team, g.week
    from public.nfl_games g, league l
    where g.season = l.season and g.season_type = 'REG'
      and g.home_team is not null
    union all
    select g.away_team, g.week
    from public.nfl_games g, league l
    where g.season = l.season and g.season_type = 'REG'
      and g.away_team is not null
  ),
  reg_weeks as (select distinct week from played),
  teams_playing as (select distinct team from played),
  bye as (
    select tp.team, min(rw.week) as week
    from teams_playing tp
    cross join reg_weeks rw
    left join played p on p.team = tp.team and p.week = rw.week
    where p.team is null
    group by tp.team
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
      pr.points                         as proj_points,
      p.injury_status,
      p.injury_body_part,
      bw.week                           as bye_week,
      ng.opponent                       as next_opponent,
      ng.kickoff_at                     as next_kickoff,
      ng.is_home                        as next_is_home
    from public.nfl_players p
    cross join wanted w
    left join owned         o  on o.player_id  = p.id
    left join held          h  on h.player_id  = p.id
    left join season_totals st on st.player_id = p.id
    left join projection    pr on pr.player_id = p.id
    left join last_week     lw on lw.player_id = p.id
    left join bye           bw on bw.team      = p.team_abbr
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
    case when p_dir <> 'asc' and p_sort = 'points'     then f.total_points end desc nulls last,
    case when p_dir <> 'asc' and p_sort = 'projection' then f.proj_points  end desc nulls last,
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
    case when p_dir = 'asc' and p_sort = 'points'     then f.total_points end asc nulls last,
    case when p_dir = 'asc' and p_sort = 'projection' then f.proj_points  end asc nulls last,
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

/**
 * The best player still available, by one team's chosen measure.
 *
 * Every strategy carries the other two as tiebreaks, because any one of
 * them is silent about somebody: ADP says nothing about a player nobody
 * is drafting, last season says nothing about a rookie, and a
 * projection says nothing about anyone the feed skipped. Falling
 * through the other measures beats falling through to alphabetical.
 */
create or replace function public.autopick_fallback(
  p_league uuid, p_strategy text, p_season int
) returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.id
  from public.nfl_players p
  left join public.player_season_points sp
    on sp.player_id = p.id and sp.league_id = p_league
  left join public.league_season_projection(p_league, p_season) pr
    on pr.player_id = p.id
  where public.is_fantasy_player(p.id, p.position)
    and public.player_is_free(p_league, p.id)
  order by
    case when p_strategy = 'adp'        then p.adp end asc nulls last,
    case when p_strategy = 'projection' then pr.points end desc nulls last,
    case when p_strategy = 'last_season' then coalesce(sp.total_points, 0) end
      desc nulls last,
    -- The tiebreaks, in a fixed order whatever the strategy was.
    coalesce(pr.points, -1)         desc,
    coalesce(sp.total_points, 0)    desc,
    coalesce(p.adp, 9999)           asc,
    p.full_name
  limit 1;
$$;

grant execute on function public.autopick_fallback(uuid, text, int)
  to authenticated;

-- ---------------------------------------------------------------------
-- Who autopick would take
-- ---------------------------------------------------------------------
--
-- Split out of autopick() so the draft room can show the answer before
-- the clock runs out rather than after. Same rules either way, because
-- it is the same function: the queue first, skipping anybody whose
-- target round has not arrived, then the team's own fallback strategy.
--
-- Deliberately *not* readable for somebody else's team. A queue is
-- private (see the draft_queue policy in 0009) and its top name is the
-- single most valuable thing in it -- handing that to the room would
-- turn a private queue into a public one. Ask about your own team, or
-- about a team nobody owns, and you get an answer; ask about a rival's
-- and you get null.
create or replace function public.autopick_candidate(
  p_draft uuid, p_team uuid, p_round int
) returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_draft    public.drafts%rowtype;
  v_team     public.teams%rowtype;
  v_season   int;
  v_player   text;
begin
  select * into v_draft from public.drafts where id = p_draft;
  if not found then return null; end if;

  select * into v_team from public.teams where id = p_team;
  if not found or v_team.league_id <> v_draft.league_id then return null; end if;

  if auth.uid() is not null then
    if not public.is_league_member(v_draft.league_id) then
      raise exception 'That is not your draft';
    end if;
    -- Somebody else's queue is nobody else's business.
    if v_team.owner_id is not null and v_team.owner_id <> auth.uid() then
      return null;
    end if;
  end if;

  select season into v_season from public.leagues where id = v_draft.league_id;

  select q.player_id into v_player
    from public.draft_queue q
    where q.team_id = p_team
      and (q.target_round is null or q.target_round <= coalesce(p_round, 1))
      and public.player_is_free(v_draft.league_id, q.player_id)
    order by q.rank
    limit 1;

  if v_player is not null then return v_player; end if;

  return public.autopick_fallback(v_draft.league_id, v_team.autodraft_strategy,
                                  v_season);
end;
$$;

grant execute on function public.autopick_candidate(uuid, uuid, int)
  to authenticated;


-- Autopick itself is now the candidate plus the pick ------------------
--
-- 0034's guard stays exactly as it was: any member of the league may
-- trigger an expired clock, because whoever has the room open is the
-- one who notices it run out, but a stranger may not.
--
-- The candidate lookup cannot go through autopick_candidate: that
-- refuses to answer about a team you do not own, which is the whole
-- point of it, and autopick runs on behalf of exactly such a team. The
-- rules are repeated here rather than shared, and the tests hold the
-- two to the same answer.
create or replace function public.autopick(p_draft uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_draft   public.drafts%rowtype;
  v_pick    public.draft_picks%rowtype;
  v_team    public.teams%rowtype;
  v_season  int;
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
  if not found then return null; end if;

  select * into v_team from public.teams where id = v_pick.team_id;
  select season into v_season from public.leagues where id = v_draft.league_id;

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
    v_player := public.autopick_fallback(
      v_draft.league_id, coalesce(v_team.autodraft_strategy, 'adp'), v_season
    );
  end if;

  if v_player is null then
    return null;
  end if;

  return public.make_draft_pick(p_draft, v_player, true);
end;
$$;
