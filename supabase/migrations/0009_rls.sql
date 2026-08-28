-- =====================================================================
-- 0009  Row level security
--
-- The rule of the app: you can read anything inside a league you belong
-- to, but you can only *write* your own team. Roster-changing operations
-- (add/drop, waivers, draft picks) deliberately have no write policy --
-- they go through SECURITY DEFINER functions in 0011 so the legality
-- checks cannot be bypassed by talking to PostgREST directly.
--
-- Pending waiver bids are the one read exception: blind bidding only
-- works if nobody can see anybody else's pending claim.
-- =====================================================================

-- Helpers ---------------------------------------------------------------
-- These are SECURITY DEFINER so that a policy on league_members can ask
-- "is this user a member?" without recursively invoking its own policy.

create or replace function public.is_league_member(p_league uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.league_members
    where league_id = p_league and user_id = auth.uid()
  );
$$;

create or replace function public.is_commissioner(p_league uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.league_members
    where league_id = p_league
      and user_id = auth.uid()
      and role = 'commissioner'
  );
$$;

create or replace function public.owns_team(p_team uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.teams
    where id = p_team and owner_id = auth.uid()
  );
$$;

create or replace function public.team_league(p_team uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select league_id from public.teams where id = p_team;
$$;

grant execute on function public.is_league_member(uuid) to authenticated;
grant execute on function public.is_commissioner(uuid)  to authenticated;
grant execute on function public.owns_team(uuid)        to authenticated;
grant execute on function public.team_league(uuid)      to authenticated;

-- Enable RLS everywhere -------------------------------------------------
alter table public.profiles            enable row level security;
alter table public.leagues             enable row level security;
alter table public.league_members      enable row level security;
alter table public.teams               enable row level security;
alter table public.roster_slots        enable row level security;
alter table public.league_invites      enable row level security;
alter table public.nfl_teams           enable row level security;
alter table public.nfl_players         enable row level security;
alter table public.nfl_games           enable row level security;
alter table public.nfl_byes            enable row level security;
alter table public.player_game_stats   enable row level security;
alter table public.ingest_runs         enable row level security;
alter table public.stat_definitions    enable row level security;
alter table public.league_scoring_rules enable row level security;
alter table public.player_week_scores  enable row level security;
alter table public.roster_players      enable row level security;
alter table public.lineup_entries      enable row level security;
alter table public.matchups            enable row level security;
alter table public.transactions        enable row level security;
alter table public.waiver_claims       enable row level security;
alter table public.waiver_holds        enable row level security;
alter table public.trades              enable row level security;
alter table public.trade_items         enable row level security;
alter table public.drafts              enable row level security;
alter table public.draft_order         enable row level security;
alter table public.draft_picks         enable row level security;
alter table public.auction_lots        enable row level security;
alter table public.auction_bids        enable row level security;
alter table public.draft_queue         enable row level security;
alter table public.league_messages     enable row level security;

-- Profiles --------------------------------------------------------------
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select to authenticated using (true);

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Shared NFL reference data: readable by anyone signed in, written only
-- by the ingestion jobs (which use the service role and bypass RLS).
drop policy if exists nfl_teams_read on public.nfl_teams;
create policy nfl_teams_read on public.nfl_teams
  for select to authenticated using (true);

drop policy if exists nfl_players_read on public.nfl_players;
create policy nfl_players_read on public.nfl_players
  for select to authenticated using (true);

drop policy if exists nfl_games_read on public.nfl_games;
create policy nfl_games_read on public.nfl_games
  for select to authenticated using (true);

drop policy if exists nfl_byes_read on public.nfl_byes;
create policy nfl_byes_read on public.nfl_byes
  for select to authenticated using (true);

drop policy if exists pgs_read on public.player_game_stats;
create policy pgs_read on public.player_game_stats
  for select to authenticated using (true);

drop policy if exists stat_definitions_read on public.stat_definitions;
create policy stat_definitions_read on public.stat_definitions
  for select to authenticated using (true);

drop policy if exists ingest_runs_read on public.ingest_runs;
create policy ingest_runs_read on public.ingest_runs
  for select to authenticated using (true);

-- Leagues ---------------------------------------------------------------
drop policy if exists leagues_read on public.leagues;
create policy leagues_read on public.leagues
  for select to authenticated using (public.is_league_member(id));

drop policy if exists leagues_create on public.leagues;
create policy leagues_create on public.leagues
  for insert to authenticated with check (commissioner_id = auth.uid());

drop policy if exists leagues_update on public.leagues;
create policy leagues_update on public.leagues
  for update to authenticated
  using (public.is_commissioner(id)) with check (public.is_commissioner(id));

drop policy if exists leagues_delete on public.leagues;
create policy leagues_delete on public.leagues
  for delete to authenticated using (commissioner_id = auth.uid());

-- Membership ------------------------------------------------------------
drop policy if exists league_members_read on public.league_members;
create policy league_members_read on public.league_members
  for select to authenticated
  using (user_id = auth.uid() or public.is_league_member(league_id));

drop policy if exists league_members_manage on public.league_members;
create policy league_members_manage on public.league_members
  for all to authenticated
  using (public.is_commissioner(league_id))
  with check (public.is_commissioner(league_id));

drop policy if exists league_members_leave on public.league_members;
create policy league_members_leave on public.league_members
  for delete to authenticated using (user_id = auth.uid());

-- Teams -----------------------------------------------------------------
drop policy if exists teams_read on public.teams;
create policy teams_read on public.teams
  for select to authenticated using (public.is_league_member(league_id));

drop policy if exists teams_commissioner_write on public.teams;
create policy teams_commissioner_write on public.teams
  for all to authenticated
  using (public.is_commissioner(league_id))
  with check (public.is_commissioner(league_id));

-- An owner can rename their own team but not change league or budget;
-- the guard trigger in 0011 enforces which columns are editable.
drop policy if exists teams_owner_update on public.teams;
create policy teams_owner_update on public.teams
  for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Roster configuration ---------------------------------------------------
drop policy if exists roster_slots_read on public.roster_slots;
create policy roster_slots_read on public.roster_slots
  for select to authenticated using (public.is_league_member(league_id));

drop policy if exists roster_slots_write on public.roster_slots;
create policy roster_slots_write on public.roster_slots
  for all to authenticated
  using (public.is_commissioner(league_id))
  with check (public.is_commissioner(league_id));

-- Invites ---------------------------------------------------------------
drop policy if exists league_invites_read on public.league_invites;
create policy league_invites_read on public.league_invites
  for select to authenticated
  using (public.is_commissioner(league_id)
         or lower(email) = lower(coalesce(auth.jwt()->>'email', '')));

drop policy if exists league_invites_write on public.league_invites;
create policy league_invites_write on public.league_invites
  for all to authenticated
  using (public.is_commissioner(league_id))
  with check (public.is_commissioner(league_id));

-- Scoring ---------------------------------------------------------------
drop policy if exists lsr_read on public.league_scoring_rules;
create policy lsr_read on public.league_scoring_rules
  for select to authenticated using (public.is_league_member(league_id));

drop policy if exists lsr_write on public.league_scoring_rules;
create policy lsr_write on public.league_scoring_rules
  for all to authenticated
  using (public.is_commissioner(league_id))
  with check (public.is_commissioner(league_id));

drop policy if exists pws_read on public.player_week_scores;
create policy pws_read on public.player_week_scores
  for select to authenticated using (public.is_league_member(league_id));

-- Rosters ---------------------------------------------------------------
-- Read only. Every mutation goes through the RPCs in 0011.
drop policy if exists roster_players_read on public.roster_players;
create policy roster_players_read on public.roster_players
  for select to authenticated using (public.is_league_member(league_id));

-- Lineups ---------------------------------------------------------------
drop policy if exists lineup_read on public.lineup_entries;
create policy lineup_read on public.lineup_entries
  for select to authenticated using (public.is_league_member(league_id));

drop policy if exists lineup_owner_write on public.lineup_entries;
create policy lineup_owner_write on public.lineup_entries
  for all to authenticated
  using (public.owns_team(team_id) or public.is_commissioner(league_id))
  with check (public.owns_team(team_id) or public.is_commissioner(league_id));

-- Matchups --------------------------------------------------------------
drop policy if exists matchups_read on public.matchups;
create policy matchups_read on public.matchups
  for select to authenticated using (public.is_league_member(league_id));

drop policy if exists matchups_write on public.matchups;
create policy matchups_write on public.matchups
  for all to authenticated
  using (public.is_commissioner(league_id))
  with check (public.is_commissioner(league_id));

-- Transaction log: readable by the whole league, append-only via RPC.
drop policy if exists transactions_read on public.transactions;
create policy transactions_read on public.transactions
  for select to authenticated using (public.is_league_member(league_id));

-- Waivers ---------------------------------------------------------------
-- Blind bidding: a pending claim is visible only to the team that made it.
drop policy if exists waiver_claims_read on public.waiver_claims;
create policy waiver_claims_read on public.waiver_claims
  for select to authenticated
  using (
    public.owns_team(team_id)
    or (status <> 'pending' and public.is_league_member(league_id))
  );

drop policy if exists waiver_claims_write on public.waiver_claims;
create policy waiver_claims_write on public.waiver_claims
  for all to authenticated
  using (public.owns_team(team_id))
  with check (public.owns_team(team_id) and status = 'pending');

drop policy if exists waiver_holds_read on public.waiver_holds;
create policy waiver_holds_read on public.waiver_holds
  for select to authenticated using (public.is_league_member(league_id));

-- Trades ----------------------------------------------------------------
drop policy if exists trades_read on public.trades;
create policy trades_read on public.trades
  for select to authenticated using (public.is_league_member(league_id));

drop policy if exists trades_propose on public.trades;
create policy trades_propose on public.trades
  for insert to authenticated
  with check (public.owns_team(proposing_team_id) and status = 'pending');

drop policy if exists trades_respond on public.trades;
create policy trades_respond on public.trades
  for update to authenticated
  using (
    public.owns_team(proposing_team_id)
    or public.owns_team(receiving_team_id)
    or public.is_commissioner(league_id)
  )
  with check (
    public.owns_team(proposing_team_id)
    or public.owns_team(receiving_team_id)
    or public.is_commissioner(league_id)
  );

drop policy if exists trade_items_read on public.trade_items;
create policy trade_items_read on public.trade_items
  for select to authenticated
  using (exists (
    select 1 from public.trades t
    where t.id = trade_id and public.is_league_member(t.league_id)
  ));

drop policy if exists trade_items_write on public.trade_items;
create policy trade_items_write on public.trade_items
  for all to authenticated
  using (exists (
    select 1 from public.trades t
    where t.id = trade_id and public.owns_team(t.proposing_team_id)
      and t.status = 'pending'
  ))
  with check (exists (
    select 1 from public.trades t
    where t.id = trade_id and public.owns_team(t.proposing_team_id)
      and t.status = 'pending'
  ));

-- Draft -----------------------------------------------------------------
drop policy if exists drafts_read on public.drafts;
create policy drafts_read on public.drafts
  for select to authenticated using (public.is_league_member(league_id));

drop policy if exists drafts_write on public.drafts;
create policy drafts_write on public.drafts
  for all to authenticated
  using (public.is_commissioner(league_id))
  with check (public.is_commissioner(league_id));

drop policy if exists draft_order_read on public.draft_order;
create policy draft_order_read on public.draft_order
  for select to authenticated
  using (exists (
    select 1 from public.drafts d
    where d.id = draft_id and public.is_league_member(d.league_id)
  ));

drop policy if exists draft_picks_read on public.draft_picks;
create policy draft_picks_read on public.draft_picks
  for select to authenticated using (public.is_league_member(league_id));

drop policy if exists auction_lots_read on public.auction_lots;
create policy auction_lots_read on public.auction_lots
  for select to authenticated
  using (exists (
    select 1 from public.drafts d
    where d.id = draft_id and public.is_league_member(d.league_id)
  ));

drop policy if exists auction_bids_read on public.auction_bids;
create policy auction_bids_read on public.auction_bids
  for select to authenticated
  using (exists (
    select 1 from public.auction_lots l
    join public.drafts d on d.id = l.draft_id
    where l.id = lot_id and public.is_league_member(d.league_id)
  ));

-- A manager's draft queue is private to them.
drop policy if exists draft_queue_own on public.draft_queue;
create policy draft_queue_own on public.draft_queue
  for all to authenticated
  using (public.owns_team(team_id)) with check (public.owns_team(team_id));

-- Message board ---------------------------------------------------------
drop policy if exists messages_read on public.league_messages;
create policy messages_read on public.league_messages
  for select to authenticated using (public.is_league_member(league_id));

drop policy if exists messages_post on public.league_messages;
create policy messages_post on public.league_messages
  for insert to authenticated
  with check (user_id = auth.uid() and public.is_league_member(league_id)
              and is_system = false);

drop policy if exists messages_edit_own on public.league_messages;
create policy messages_edit_own on public.league_messages
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists messages_delete on public.league_messages;
create policy messages_delete on public.league_messages
  for delete to authenticated
  using (user_id = auth.uid() or public.is_commissioner(league_id));
