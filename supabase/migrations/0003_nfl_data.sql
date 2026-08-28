-- =====================================================================
-- 0003  NFL reference data + the raw stat store
--
-- Design note: per-game stats live in a jsonb `stats` map rather than
-- hundreds of typed columns. nflverse exposes an enormous and *growing*
-- stat surface (play-by-play alone is ~380 columns); a jsonb map lets us
-- ingest new stats without a migration, and the scoring engine just
-- walks the key/value pairs against the league's rule table.
-- =====================================================================

create table if not exists public.nfl_teams (
  abbr        text primary key,
  name        text not null,
  conference  text,
  division    text,
  logo_url    text
);

create table if not exists public.nfl_players (
  id            text primary key,              -- nflverse gsis_id
  full_name     text not null,
  first_name    text,
  last_name     text,
  position      text,                          -- QB RB WR TE K DL LB DB ...
  team_abbr     text references public.nfl_teams(abbr),
  jersey_number int,
  status        text,                          -- ACT, RES, CUT, ...
  height        text,
  weight        int,
  college       text,
  birth_date    date,
  years_exp     int,
  headshot_url  text,
  espn_id       text,
  sleeper_id    text,
  search_name   text generated always as (lower(full_name)) stored,
  updated_at    timestamptz not null default now()
);

create index if not exists nfl_players_pos_idx    on public.nfl_players(position);
create index if not exists nfl_players_team_idx   on public.nfl_players(team_abbr);
create index if not exists nfl_players_search_idx on public.nfl_players(search_name text_pattern_ops);
create index if not exists nfl_players_espn_idx   on public.nfl_players(espn_id);

create table if not exists public.nfl_games (
  id           text primary key,               -- nflverse game_id, e.g. 2026_01_KC_BAL
  season       int  not null,
  week         int  not null,
  season_type  text not null default 'REG' check (season_type in ('PRE','REG','POST')),
  home_team    text references public.nfl_teams(abbr),
  away_team    text references public.nfl_teams(abbr),
  kickoff_at   timestamptz,
  home_score   int,
  away_score   int,
  status       text not null default 'scheduled'
               check (status in ('scheduled','in_progress','final','postponed')),
  espn_id      text,
  updated_at   timestamptz not null default now()
);

create index if not exists nfl_games_week_idx   on public.nfl_games(season, week);
create index if not exists nfl_games_kickoff_idx on public.nfl_games(kickoff_at);
create index if not exists nfl_games_espn_idx   on public.nfl_games(espn_id);

-- Which teams are on bye, derived per season/week -----------------------
create table if not exists public.nfl_byes (
  season    int  not null,
  week      int  not null,
  team_abbr text not null references public.nfl_teams(abbr),
  primary key (season, team_abbr)
);

-- Raw per-player, per-game stat lines ----------------------------------
create table if not exists public.player_game_stats (
  id          bigint generated always as identity primary key,
  player_id   text not null references public.nfl_players(id) on delete cascade,
  game_id     text not null references public.nfl_games(id) on delete cascade,
  season      int  not null,
  week        int  not null,
  season_type text not null default 'REG',
  team_abbr   text,
  opponent    text,
  -- 'final' once the official nflverse line lands; 'live' while we are
  -- polling ESPN mid-game so the UI can flag provisional numbers
  source      text not null default 'live' check (source in ('live','final')),
  stats       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  unique (player_id, game_id)
);

create index if not exists pgs_week_idx    on public.player_game_stats(season, week);
create index if not exists pgs_player_idx  on public.player_game_stats(player_id, season, week);
create index if not exists pgs_stats_gin   on public.player_game_stats using gin (stats);

-- Team defense / special teams stat lines -------------------------------
create table if not exists public.team_game_stats (
  id          bigint generated always as identity primary key,
  team_abbr   text not null references public.nfl_teams(abbr) on delete cascade,
  game_id     text not null references public.nfl_games(id) on delete cascade,
  season      int  not null,
  week        int  not null,
  season_type text not null default 'REG',
  opponent    text,
  source      text not null default 'live' check (source in ('live','final')),
  stats       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  unique (team_abbr, game_id)
);

create index if not exists tgs_week_idx  on public.team_game_stats(season, week);
create index if not exists tgs_stats_gin on public.team_game_stats using gin (stats);

-- Bookkeeping for the ingestion jobs ------------------------------------
create table if not exists public.ingest_runs (
  id          bigint generated always as identity primary key,
  job         text not null,
  season      int,
  week        int,
  status      text not null default 'running' check (status in ('running','success','error')),
  rows_written int not null default 0,
  message     text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists ingest_runs_job_idx on public.ingest_runs(job, started_at desc);
