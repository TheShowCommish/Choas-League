-- =====================================================================
-- 0006  Transaction log, waiver claims, trades
-- =====================================================================

-- The append-only league activity feed. Everything that changes a roster
-- writes a row here so the league can audit it.
create table if not exists public.transactions (
  id              uuid primary key default gen_random_uuid(),
  league_id       uuid not null references public.leagues(id) on delete cascade,
  team_id         uuid references public.teams(id) on delete set null,
  related_team_id uuid references public.teams(id) on delete set null,
  type            text not null check (type in
                    ('add','drop','waiver_add','waiver_failed',
                     'trade','draft','commissioner')),
  player_id       text references public.nfl_players(id) on delete set null,
  bid_amount      int,
  season          int not null,
  week            int not null,
  note            text not null default '',
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists transactions_league_idx
  on public.transactions(league_id, created_at desc);
create index if not exists transactions_team_idx
  on public.transactions(team_id, created_at desc);

-- Waiver claims ---------------------------------------------------------
create table if not exists public.waiver_claims (
  id              uuid primary key default gen_random_uuid(),
  league_id       uuid not null references public.leagues(id) on delete cascade,
  team_id         uuid not null references public.teams(id) on delete cascade,
  add_player_id   text not null references public.nfl_players(id) on delete cascade,
  -- optional corresponding drop, so the roster stays legal on award
  drop_player_id  text references public.nfl_players(id) on delete set null,
  bid_amount      int not null default 0 check (bid_amount >= 0),
  -- a team orders its own claims; lower number processes first
  claim_priority  int not null default 1,
  status          text not null default 'pending'
                  check (status in ('pending','won','lost','invalid','cancelled')),
  result_note     text not null default '',
  season          int not null,
  week            int not null,
  created_at      timestamptz not null default now(),
  processed_at    timestamptz,
  processed_batch uuid
);

create index if not exists waiver_claims_pending_idx
  on public.waiver_claims(league_id, status) where status = 'pending';
create index if not exists waiver_claims_team_idx
  on public.waiver_claims(team_id, created_at desc);

-- One pending claim per team per player.
create unique index if not exists waiver_claims_one_per_player
  on public.waiver_claims(team_id, add_player_id) where status = 'pending';

-- Players sitting on waivers after being dropped -------------------------
create table if not exists public.waiver_holds (
  id         uuid primary key default gen_random_uuid(),
  league_id  uuid not null references public.leagues(id) on delete cascade,
  player_id  text not null references public.nfl_players(id) on delete cascade,
  clears_at  timestamptz not null,
  created_at timestamptz not null default now(),
  unique (league_id, player_id)
);

create index if not exists waiver_holds_clears_idx on public.waiver_holds(clears_at);

-- Trades ----------------------------------------------------------------
create table if not exists public.trades (
  id                uuid primary key default gen_random_uuid(),
  league_id         uuid not null references public.leagues(id) on delete cascade,
  proposing_team_id uuid not null references public.teams(id) on delete cascade,
  receiving_team_id uuid not null references public.teams(id) on delete cascade,
  status            text not null default 'pending'
                    check (status in ('pending','accepted','rejected','cancelled','vetoed','completed')),
  note              text not null default '',
  season            int not null,
  week              int not null,
  created_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  responded_at      timestamptz,
  completed_at      timestamptz,
  expires_at        timestamptz not null default (now() + interval '3 days'),
  check (proposing_team_id <> receiving_team_id)
);

create index if not exists trades_league_idx on public.trades(league_id, created_at desc);
create index if not exists trades_pending_idx
  on public.trades(receiving_team_id) where status = 'pending';

-- One row per asset moving in a trade: either a player or some FAAB.
create table if not exists public.trade_items (
  id           uuid primary key default gen_random_uuid(),
  trade_id     uuid not null references public.trades(id) on delete cascade,
  from_team_id uuid not null references public.teams(id) on delete cascade,
  player_id    text references public.nfl_players(id) on delete cascade,
  faab_amount  int check (faab_amount > 0),
  check ((player_id is null) <> (faab_amount is null))
);

create index if not exists trade_items_trade_idx on public.trade_items(trade_id);
