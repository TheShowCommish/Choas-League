-- =====================================================================
-- 0002  Leagues, membership, teams, roster configuration
-- =====================================================================

create table if not exists public.leagues (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  season              int  not null,
  commissioner_id     uuid not null references public.profiles(id),
  join_code           text not null unique default upper(substr(encode(gen_random_bytes(6),'hex'),1,8)),

  -- season state
  status              text not null default 'setup'
                      check (status in ('setup','drafting','in_season','playoffs','complete')),
  current_week        int  not null default 1,
  regular_season_weeks int not null default 14,
  playoff_start_week  int  not null default 15,
  playoff_teams       int  not null default 6,

  -- draft
  draft_type          text not null default 'snake' check (draft_type in ('snake','auction')),

  -- waivers
  waiver_type         text not null default 'faab' check (waiver_type in ('faab','priority')),
  faab_budget         int  not null default 100,
  min_bid             int  not null default 0,
  -- 0=Sunday .. 6=Saturday, in the league's timezone
  waiver_process_dow  int  not null default 3 check (waiver_process_dow between 0 and 6),
  waiver_process_time time not null default '03:00',
  -- how long a dropped player sits on waivers before becoming a free agent
  waiver_period_hours int  not null default 48,
  faab_tie_breaker    text not null default 'waiver_priority'
                      check (faab_tie_breaker in ('waiver_priority','earliest_bid','random')),

  -- lineups
  lineup_lock_mode    text not null default 'per_player'
                      check (lineup_lock_mode in ('per_player','weekly_kickoff')),
  timezone            text not null default 'America/New_York',

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (name, season)
);

create index if not exists leagues_commissioner_idx on public.leagues(commissioner_id);

create table if not exists public.league_members (
  id         uuid primary key default gen_random_uuid(),
  league_id  uuid not null references public.leagues(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  role       text not null default 'member' check (role in ('commissioner','member')),
  joined_at  timestamptz not null default now(),
  unique (league_id, user_id)
);

create index if not exists league_members_user_idx on public.league_members(user_id);

create table if not exists public.teams (
  id               uuid primary key default gen_random_uuid(),
  league_id        uuid not null references public.leagues(id) on delete cascade,
  owner_id         uuid references public.profiles(id) on delete set null,
  name             text not null,
  abbreviation     text not null default '',
  logo_url         text,
  faab_remaining   int  not null default 100,
  waiver_priority  int  not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (league_id, name)
);

create index if not exists teams_league_idx on public.teams(league_id);
create unique index if not exists teams_one_per_owner
  on public.teams(league_id, owner_id) where owner_id is not null;

-- Roster configuration: fully commissioner-definable slots -------------
create table if not exists public.roster_slots (
  id                  uuid primary key default gen_random_uuid(),
  league_id           uuid not null references public.leagues(id) on delete cascade,
  slot_key            text not null,          -- 'QB','FLEX','BN','IR', anything
  label               text not null,
  eligible_positions  text[] not null default '{}',  -- empty = any position
  count               int  not null default 1 check (count >= 0),
  is_starter          boolean not null default true,
  order_index         int  not null default 0,
  unique (league_id, slot_key)
);

create index if not exists roster_slots_league_idx on public.roster_slots(league_id, order_index);

create table if not exists public.league_invites (
  id          uuid primary key default gen_random_uuid(),
  league_id   uuid not null references public.leagues(id) on delete cascade,
  email       text not null,
  invited_by  uuid not null references public.profiles(id),
  accepted_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (league_id, email)
);

drop trigger if exists leagues_touch on public.leagues;
create trigger leagues_touch before update on public.leagues
  for each row execute function public.touch_updated_at();

drop trigger if exists teams_touch on public.teams;
create trigger teams_touch before update on public.teams
  for each row execute function public.touch_updated_at();

-- Default roster layout applied to every new league --------------------
create or replace function public.seed_default_roster_slots()
returns trigger
language plpgsql
as $$
begin
  insert into public.roster_slots
    (league_id, slot_key, label, eligible_positions, count, is_starter, order_index)
  values
    (new.id,'QB',   'QB',        array['QB'],                        1, true,  10),
    (new.id,'RB',   'RB',        array['RB'],                        2, true,  20),
    (new.id,'WR',   'WR',        array['WR'],                        2, true,  30),
    (new.id,'TE',   'TE',        array['TE'],                        1, true,  40),
    (new.id,'FLEX', 'W/R/T',     array['RB','WR','TE'],              1, true,  50),
    (new.id,'K',    'K',         array['K'],                         1, true,  60),
    (new.id,'DEF',  'D/ST',      array['DEF'],                       1, true,  70),
    (new.id,'BN',   'Bench',     array[]::text[],                    7, false, 80),
    (new.id,'IR',   'IR',        array[]::text[],                    1, false, 90);
  return new;
end;
$$;

drop trigger if exists leagues_seed_roster on public.leagues;
create trigger leagues_seed_roster after insert on public.leagues
  for each row execute function public.seed_default_roster_slots();

-- Commissioner is automatically a member -------------------------------
create or replace function public.seed_commissioner_membership()
returns trigger
language plpgsql
as $$
begin
  insert into public.league_members (league_id, user_id, role)
  values (new.id, new.commissioner_id, 'commissioner')
  on conflict (league_id, user_id) do update set role = 'commissioner';
  return new;
end;
$$;

drop trigger if exists leagues_seed_commissioner on public.leagues;
create trigger leagues_seed_commissioner after insert on public.leagues
  for each row execute function public.seed_commissioner_membership();
