-- =====================================================================
-- 0004  The scoring engine's tables
--
--   stat_definitions    the catalog of every scorable stat we ingest
--   league_scoring_rules a league's points-per-unit for each stat
--   player_week_scores  materialised fantasy points, with a breakdown
-- =====================================================================

create table if not exists public.stat_definitions (
  key           text primary key,
  label         text not null,
  category      text not null,   -- Passing, Rushing, Receiving, Kicking, ...
  description   text not null default '',
  applies_to    text not null default 'player'
                check (applies_to in ('player','team_defense')),
  -- 'count' = additive stat, 'flag' = 0/1 bonus trigger, 'rate' = informational
  value_type    text not null default 'count'
                check (value_type in ('count','flag','rate')),
  default_points numeric(10,4) not null default 0,
  -- rate stats can't be scored on (they aren't additive across games)
  scorable      boolean not null default true,
  -- which ingestion job populates this stat
  source        text not null default 'player',
  -- false while nothing populates it yet, so the admin UI can say so
  -- rather than letting a commissioner switch on a stat that would
  -- silently never score
  tracked       boolean not null default true,
  sort_order    int not null default 0
);

create index if not exists stat_definitions_cat_idx on public.stat_definitions(category, sort_order);

create table if not exists public.league_scoring_rules (
  id         uuid primary key default gen_random_uuid(),
  league_id  uuid not null references public.leagues(id) on delete cascade,
  stat_key   text not null references public.stat_definitions(key) on delete cascade,
  points     numeric(10,4) not null default 0,
  -- null/empty = applies to every position; otherwise restrict the rule
  positions  text[] not null default '{}',
  updated_at timestamptz not null default now(),
  unique (league_id, stat_key)
);

create index if not exists lsr_league_idx on public.league_scoring_rules(league_id);

drop trigger if exists lsr_touch on public.league_scoring_rules;
create trigger lsr_touch before update on public.league_scoring_rules
  for each row execute function public.touch_updated_at();

-- Materialised fantasy points. Recomputed whenever stats land or the
-- commissioner changes a scoring rule. Team defenses appear here under
-- their 'DST_<abbr>' pseudo-player id, same as anyone else.
create table if not exists public.player_week_scores (
  id          bigint generated always as identity primary key,
  league_id   uuid not null references public.leagues(id) on delete cascade,
  player_id   text not null references public.nfl_players(id) on delete cascade,
  season      int not null,
  week        int not null,
  points      numeric(10,2) not null default 0,
  -- { stat_key: { value, points }, ... } so the UI can show the math
  breakdown   jsonb not null default '{}'::jsonb,
  is_final    boolean not null default false,
  computed_at timestamptz not null default now(),
  unique (league_id, player_id, season, week)
);

create index if not exists pws_week_idx on public.player_week_scores(league_id, season, week);
create index if not exists pws_player_idx on public.player_week_scores(league_id, player_id, season);

-- Season totals, handy for the player research page ---------------------
create or replace view public.player_season_points as
  select league_id, player_id, season,
         round(sum(points), 2)  as total_points,
         count(*)               as games,
         round(avg(points), 2)  as avg_points
  from public.player_week_scores
  group by league_id, player_id, season;
