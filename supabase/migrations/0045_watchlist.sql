-- =====================================================================
-- 0045  Player watchlist (T-074)
--
-- A per-user, per-league star list: a manager flags players -- usually
-- ones they do not own -- to keep an eye on their availability and next
-- fixture. ESPN / Yahoo / Sleeper all have this.
--
-- Unlike the notification inbox in 0044, the client writes here directly:
-- a manager adds and removes their OWN stars. That is safe because every
-- policy is scoped to the caller -- `user_id = auth.uid()` AND they must
-- still be a member of the league (the same is_league_member() helper
-- 0044's read policy uses). A manager can neither read, add nor remove a
-- star for anyone else, nor touch a league they do not belong to.
--
-- There is no SECURITY DEFINER function to grant/revoke here (0044 had
-- notify(), reached only by the server): the whole surface is the three
-- self-scoped policies below. Table privileges follow waiver_claims --
-- the existing user-writable table -- which leans on Supabase's default
-- role grants plus RLS rather than any explicit table GRANT. Every policy
-- is `to authenticated`, so anon matches none of them and is denied.
-- =====================================================================

create table if not exists public.player_watchlist (
  id         uuid primary key default gen_random_uuid(),
  league_id  uuid not null references public.leagues(id) on delete cascade,
  -- The auth user who owns the star. Profiles.id is auth.users.id.
  user_id    uuid not null references public.profiles(id) on delete cascade,
  player_id  text not null references public.nfl_players(id) on delete cascade,
  created_at timestamptz not null default now(),
  -- One star per player per user per league; the toggle relies on this.
  unique (league_id, user_id, player_id)
);

-- The watchlist query: a user's stars in a league, newest first.
create index if not exists player_watchlist_user_idx
  on public.player_watchlist (league_id, user_id, created_at desc);

alter table public.player_watchlist enable row level security;

-- Read: your own stars, in a league you still belong to. A non-member
-- (or someone else) matches nothing.
drop policy if exists player_watchlist_read on public.player_watchlist;
create policy player_watchlist_read on public.player_watchlist
  for select to authenticated
  using (
    user_id = auth.uid()
    and public.is_league_member(league_id)
  );

-- Add a star: only your own row, only in a league you belong to.
drop policy if exists player_watchlist_insert on public.player_watchlist;
create policy player_watchlist_insert on public.player_watchlist
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.is_league_member(league_id)
  );

-- Remove a star: the same rows you can read.
drop policy if exists player_watchlist_delete on public.player_watchlist;
create policy player_watchlist_delete on public.player_watchlist
  for delete to authenticated
  using (
    user_id = auth.uid()
    and public.is_league_member(league_id)
  );
