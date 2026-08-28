-- =====================================================================
-- 0011  League setup helpers + roster add/drop
--
-- roster_players has no write policy, so these SECURITY DEFINER
-- functions are the only path to changing a roster. Each one re-checks
-- ownership itself rather than trusting the caller.
-- =====================================================================

-- Seed a new league's scoring rules from the catalog defaults ----------
create or replace function public.seed_default_scoring_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.league_scoring_rules (league_id, stat_key, points)
  select new.id, key, default_points
  from public.stat_definitions
  where scorable
  on conflict (league_id, stat_key) do nothing;
  return new;
end;
$$;

drop trigger if exists leagues_seed_scoring on public.leagues;
create trigger leagues_seed_scoring after insert on public.leagues
  for each row execute function public.seed_default_scoring_rules();

-- Start every team at the league's FAAB budget -------------------------
create or replace function public.default_team_faab()
returns trigger
language plpgsql
as $$
begin
  select faab_budget into new.faab_remaining
  from public.leagues where id = new.league_id;
  return new;
end;
$$;

drop trigger if exists teams_default_faab on public.teams;
create trigger teams_default_faab before insert on public.teams
  for each row execute function public.default_team_faab();

-- Marks the current transaction as an internal write, so guard triggers
-- know the change is coming from one of our own trusted functions rather
-- than straight from a client. Transaction-local, so it cannot leak into
-- the next statement on a pooled connection.
--
-- PostgREST only exposes functions in the API schema, so a client has no
-- way to call set_config itself and forge this.
create or replace function public.begin_internal_write()
returns void
language sql
as $$
  select set_config('app.internal_write', 'on', true);
$$;

revoke execute on function public.begin_internal_write() from authenticated, anon;

-- A team owner may rename their team; everything else is commissioner
-- territory. RLS lets the owner UPDATE the row, this pins down which
-- columns they can actually move.
create or replace function public.guard_team_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Trade execution and waiver processing move FAAB and waiver priority
  -- on behalf of a manager who is not the commissioner.
  if coalesce(current_setting('app.internal_write', true), '') = 'on' then
    return new;
  end if;

  if public.is_commissioner(new.league_id) then
    return new;
  end if;

  if new.league_id          is distinct from old.league_id
     or new.owner_id        is distinct from old.owner_id
     or new.faab_remaining  is distinct from old.faab_remaining
     or new.waiver_priority is distinct from old.waiver_priority then
    raise exception 'Only the commissioner can change that field';
  end if;

  return new;
end;
$$;

drop trigger if exists teams_guard_update on public.teams;
create trigger teams_guard_update before update on public.teams
  for each row execute function public.guard_team_update();

-- Join a league by code -------------------------------------------------
create or replace function public.join_league(p_join_code text, p_team_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league  public.leagues%rowtype;
  v_team_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  select * into v_league from public.leagues
  where upper(join_code) = upper(trim(p_join_code));

  if not found then
    raise exception 'No league with that join code';
  end if;

  insert into public.league_members (league_id, user_id, role)
  values (v_league.id, auth.uid(), 'member')
  on conflict (league_id, user_id) do nothing;

  select id into v_team_id from public.teams
  where league_id = v_league.id and owner_id = auth.uid();

  if v_team_id is null then
    insert into public.teams (league_id, owner_id, name, waiver_priority)
    values (
      v_league.id,
      auth.uid(),
      coalesce(nullif(trim(p_team_name), ''), 'Team ' || substr(auth.uid()::text, 1, 4)),
      coalesce((select max(waiver_priority) + 1 from public.teams
                where league_id = v_league.id), 1)
    )
    returning id into v_team_id;
  end if;

  update public.league_invites
    set accepted_at = now()
    where league_id = v_league.id
      and lower(email) = lower(coalesce(auth.jwt()->>'email', ''));

  return v_team_id;
end;
$$;

-- Roster capacity -------------------------------------------------------
create or replace function public.roster_capacity(p_league uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(count), 0)::int
  from public.roster_slots where league_id = p_league;
$$;

create or replace function public.roster_size(p_team uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int from public.roster_players
  where team_id = p_team and dropped_at is null;
$$;

-- Availability ----------------------------------------------------------
create or replace function public.player_is_free(p_league uuid, p_player text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (
    select 1 from public.roster_players
    where league_id = p_league and player_id = p_player and dropped_at is null
  );
$$;

create or replace function public.player_on_waivers(p_league uuid, p_player text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.waiver_holds
    where league_id = p_league and player_id = p_player and clears_at > now()
  );
$$;

-- Drop a player ---------------------------------------------------------
-- Internal: no permission check, callers do that. Puts the player on
-- waivers for the league's waiver period so he can't be instantly
-- re-added by whoever is watching the transaction log.
create or replace function public.internal_drop(
  p_team uuid, p_player text, p_log boolean default true
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league uuid;
  v_hours  int;
  v_season int;
  v_week   int;
begin
  select league_id into v_league from public.teams where id = p_team;
  select waiver_period_hours, season, current_week
    into v_hours, v_season, v_week
    from public.leagues where id = v_league;

  update public.roster_players
    set dropped_at = now()
    where team_id = p_team and player_id = p_player and dropped_at is null;

  if not found then
    raise exception 'That player is not on your roster';
  end if;

  -- Pull him out of any lineup that has not locked yet.
  delete from public.lineup_entries
    where team_id = p_team and player_id = p_player
      and season = v_season and week >= v_week and locked_at is null;

  if v_hours > 0 then
    insert into public.waiver_holds (league_id, player_id, clears_at)
    values (v_league, p_player, now() + make_interval(hours => v_hours))
    on conflict (league_id, player_id) do update set clears_at = excluded.clears_at;
  end if;

  if p_log then
    insert into public.transactions
      (league_id, team_id, type, player_id, season, week, created_by)
    values (v_league, p_team, 'drop', p_player, v_season, v_week, auth.uid());
  end if;
end;
$$;

-- Add a free agent immediately (not a waiver claim) ---------------------
create or replace function public.add_free_agent(
  p_team uuid, p_player text, p_drop_player text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league uuid;
  v_season int;
  v_week   int;
begin
  if not public.owns_team(p_team) then
    raise exception 'That is not your team';
  end if;

  select league_id into v_league from public.teams where id = p_team;
  select season, current_week into v_season, v_week
    from public.leagues where id = v_league;

  if not public.player_is_free(v_league, p_player) then
    raise exception 'That player is already on a roster';
  end if;
  if public.player_on_waivers(v_league, p_player) then
    raise exception 'That player is on waivers. Put in a waiver claim instead.';
  end if;

  if p_drop_player is not null then
    perform public.internal_drop(p_team, p_drop_player, true);
  end if;

  if public.roster_size(p_team) >= public.roster_capacity(v_league) then
    raise exception 'Your roster is full. Drop someone first.';
  end if;

  insert into public.roster_players (league_id, team_id, player_id, acquired_via)
  values (v_league, p_team, p_player, 'free_agent');

  insert into public.transactions
    (league_id, team_id, type, player_id, season, week, created_by)
  values (v_league, p_team, 'add', p_player, v_season, v_week, auth.uid());
end;
$$;

-- Drop a player (public entry point) ------------------------------------
create or replace function public.drop_player(p_team uuid, p_player text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.owns_team(p_team) then
    raise exception 'That is not your team';
  end if;
  perform public.internal_drop(p_team, p_player, true);
end;
$$;

grant execute on function public.join_league(text, text)             to authenticated;
grant execute on function public.roster_capacity(uuid)               to authenticated;
grant execute on function public.roster_size(uuid)                   to authenticated;
grant execute on function public.player_is_free(uuid, text)          to authenticated;
grant execute on function public.player_on_waivers(uuid, text)       to authenticated;
grant execute on function public.add_free_agent(uuid, text, text)    to authenticated;
grant execute on function public.drop_player(uuid, text)             to authenticated;
revoke execute on function public.internal_drop(uuid, text, boolean) from authenticated, anon;
