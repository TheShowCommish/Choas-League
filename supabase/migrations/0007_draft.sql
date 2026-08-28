-- =====================================================================
-- 0007  Draft: snake and auction
--
-- The draft room is hidden until the commissioner flips `status` to
-- 'live'; the UI keys off that, and picks are made through an RPC that
-- checks whose turn it is. As everywhere else, a D/ST is just a player
-- with a 'DST_<abbr>' id.
-- =====================================================================

create table if not exists public.drafts (
  id                 uuid primary key default gen_random_uuid(),
  league_id          uuid not null references public.leagues(id) on delete cascade,
  type               text not null default 'snake' check (type in ('snake','auction')),
  status             text not null default 'scheduled'
                     check (status in ('scheduled','live','paused','complete')),
  rounds             int  not null default 16,
  seconds_per_pick   int  not null default 90,
  -- auction only
  auction_budget     int  not null default 200,
  seconds_per_nomination int not null default 30,
  seconds_per_bid    int  not null default 10,

  scheduled_at       timestamptz,
  started_at         timestamptz,
  completed_at       timestamptz,
  -- 1-based; points at the row in draft_picks currently on the clock
  current_pick_number int not null default 1,
  pick_deadline      timestamptz,
  -- when true, an expired clock auto-drafts the best available player
  autopick_enabled   boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (league_id)
);

drop trigger if exists drafts_touch on public.drafts;
create trigger drafts_touch before update on public.drafts
  for each row execute function public.touch_updated_at();

create table if not exists public.draft_order (
  draft_id  uuid not null references public.drafts(id) on delete cascade,
  team_id   uuid not null references public.teams(id) on delete cascade,
  position  int  not null,
  primary key (draft_id, team_id),
  unique (draft_id, position)
);

-- Every pick slot is pre-created when the draft is generated, so the board
-- renders in full and "who is on the clock" is a single indexed lookup.
create table if not exists public.draft_picks (
  id            uuid primary key default gen_random_uuid(),
  draft_id      uuid not null references public.drafts(id) on delete cascade,
  league_id     uuid not null references public.leagues(id) on delete cascade,
  pick_number   int  not null,
  round         int  not null,
  round_pick    int  not null,
  team_id       uuid not null references public.teams(id) on delete cascade,
  player_id     text references public.nfl_players(id) on delete set null,
  is_autopick   boolean not null default false,
  bid_amount    int,
  picked_at     timestamptz,
  unique (draft_id, pick_number)
);

create index if not exists draft_picks_draft_idx on public.draft_picks(draft_id, pick_number);
create index if not exists draft_picks_team_idx  on public.draft_picks(team_id);

-- Auction: the player currently up for bid and the live high bid.
create table if not exists public.auction_lots (
  id                uuid primary key default gen_random_uuid(),
  draft_id          uuid not null references public.drafts(id) on delete cascade,
  player_id         text not null references public.nfl_players(id) on delete cascade,
  nominated_by      uuid not null references public.teams(id) on delete cascade,
  high_bid          int  not null default 1,
  high_bidder_id    uuid references public.teams(id) on delete set null,
  status            text not null default 'open' check (status in ('open','sold','passed')),
  closes_at         timestamptz,
  created_at        timestamptz not null default now(),
  closed_at         timestamptz
);

create index if not exists auction_lots_open_idx
  on public.auction_lots(draft_id) where status = 'open';

create table if not exists public.auction_bids (
  id        uuid primary key default gen_random_uuid(),
  lot_id    uuid not null references public.auction_lots(id) on delete cascade,
  team_id   uuid not null references public.teams(id) on delete cascade,
  amount    int  not null check (amount > 0),
  created_at timestamptz not null default now()
);

create index if not exists auction_bids_lot_idx on public.auction_bids(lot_id, amount desc);

-- A manager's private pre-draft ranking, also used to drive autopick.
create table if not exists public.draft_queue (
  id        uuid primary key default gen_random_uuid(),
  team_id   uuid not null references public.teams(id) on delete cascade,
  player_id text not null references public.nfl_players(id) on delete cascade,
  rank      int  not null default 0,
  unique (team_id, player_id)
);

create index if not exists draft_queue_team_idx on public.draft_queue(team_id, rank);
