-- =====================================================================
-- 0005  Rosters, weekly lineups, matchups and standings
--
-- A team defense is just a player whose id is 'DST_<abbr>', so nothing
-- in here needs a special case for the D/ST slot.
-- =====================================================================

-- Who is on a team right now. A row with dropped_at set is history.
create table if not exists public.roster_players (
  id            uuid primary key default gen_random_uuid(),
  league_id     uuid not null references public.leagues(id) on delete cascade,
  team_id       uuid not null references public.teams(id) on delete cascade,
  player_id     text not null references public.nfl_players(id) on delete cascade,
  acquired_via  text not null default 'free_agent'
                check (acquired_via in ('draft','free_agent','waiver','trade','commissioner')),
  acquired_at   timestamptz not null default now(),
  dropped_at    timestamptz
);

create index if not exists roster_players_team_idx
  on public.roster_players(team_id) where dropped_at is null;
create index if not exists roster_players_league_idx
  on public.roster_players(league_id) where dropped_at is null;

-- A player can only be on one active roster per league.
create unique index if not exists roster_players_one_owner
  on public.roster_players(league_id, player_id) where dropped_at is null;

-- The weekly lineup. One row per rostered player per week; the slot_key
-- says whether he is starting, benched or on IR.
create table if not exists public.lineup_entries (
  id         uuid primary key default gen_random_uuid(),
  league_id  uuid not null references public.leagues(id) on delete cascade,
  team_id    uuid not null references public.teams(id) on delete cascade,
  season     int  not null,
  week       int  not null,
  player_id  text not null references public.nfl_players(id) on delete cascade,
  slot_key   text not null,
  -- stamped when the player's game kicks off; a locked row cannot be moved
  locked_at  timestamptz,
  updated_at timestamptz not null default now(),
  unique (team_id, season, week, player_id)
);

create index if not exists lineup_week_idx
  on public.lineup_entries(league_id, season, week);
create index if not exists lineup_team_week_idx
  on public.lineup_entries(team_id, season, week);

drop trigger if exists lineup_touch on public.lineup_entries;
create trigger lineup_touch before update on public.lineup_entries
  for each row execute function public.touch_updated_at();

-- Head-to-head schedule --------------------------------------------------
create table if not exists public.matchups (
  id            uuid primary key default gen_random_uuid(),
  league_id     uuid not null references public.leagues(id) on delete cascade,
  season        int  not null,
  week          int  not null,
  home_team_id  uuid not null references public.teams(id) on delete cascade,
  -- null = a bye week for the home team
  away_team_id  uuid references public.teams(id) on delete cascade,
  home_score    numeric(10,2) not null default 0,
  away_score    numeric(10,2) not null default 0,
  is_playoff    boolean not null default false,
  playoff_round text,
  status        text not null default 'scheduled'
                check (status in ('scheduled','in_progress','final')),
  updated_at    timestamptz not null default now(),
  unique (league_id, season, week, home_team_id)
);

create index if not exists matchups_week_idx on public.matchups(league_id, season, week);

drop trigger if exists matchups_touch on public.matchups;
create trigger matchups_touch before update on public.matchups
  for each row execute function public.touch_updated_at();

-- Standings, derived. Every matchup contributes one row per side, so a
-- group-by gives the record, points for and points against in one pass.
create or replace view public.standings as
with sides as (
  select league_id, season, week, home_team_id as team_id,
         home_score as pf, away_score as pa, status, is_playoff
  from public.matchups
  where away_team_id is not null
  union all
  select league_id, season, week, away_team_id as team_id,
         away_score as pf, home_score as pa, status, is_playoff
  from public.matchups
  where away_team_id is not null
)
select
  t.league_id,
  t.id                                                                    as team_id,
  t.name                                                                  as team_name,
  t.owner_id,
  coalesce(count(*) filter (where s.status = 'final'), 0)                  as games_played,
  coalesce(count(*) filter (where s.status = 'final' and s.pf > s.pa), 0)  as wins,
  coalesce(count(*) filter (where s.status = 'final' and s.pf < s.pa), 0)  as losses,
  coalesce(count(*) filter (where s.status = 'final' and s.pf = s.pa), 0)  as ties,
  coalesce(round(sum(s.pf) filter (where s.status = 'final'), 2), 0)       as points_for,
  coalesce(round(sum(s.pa) filter (where s.status = 'final'), 2), 0)       as points_against,
  coalesce(round(
    sum(case when s.status = 'final' and s.pf > s.pa then 1
             when s.status = 'final' and s.pf = s.pa then 0.5
             else 0 end)
    / nullif(count(*) filter (where s.status = 'final'), 0), 4), 0)        as win_pct
from public.teams t
left join sides s on s.team_id = t.id and s.is_playoff = false
group by t.league_id, t.id, t.name, t.owner_id;
