-- =====================================================================
-- 0042  Lineup locks, enforced by the database
--
-- A lineup used to lock only when the lock-lineups job stamped
-- locked_at, and the only thing that respected the stamp was the
-- my-team server action. So a manager could move a player into or out
-- of his starting lineup after the player's game had kicked off -- or
-- finished -- whenever the job had not run yet, or at any time by
-- writing lineup_entries directly (RLS lets him write his own team).
-- lineup_lock_mode was stored and never read.
--
-- The rule now lives in a trigger on lineup_entries, so every path --
-- server actions, the RPCs, a direct PostgREST write under RLS -- goes
-- through it, and it works from kickoff times rather than from the
-- stamp, so it does not depend on the job having run:
--
--   per_player      a player cannot move into or out of a starting slot
--                   once his NFL game for that week has kicked off.
--   weekly_kickoff  nobody can, once the week's first game has kicked
--                   off.
--
-- Bench-to-bench (BN <-> IR, or on and off the board) stays open: the
-- bench does not score. A player on a bye has no game to kick off, so
-- in per_player mode he never locks -- he scores nothing wherever he
-- sits. In weekly_kickoff mode he locks with everybody else.
--
-- A stamped locked_at still counts as locked on its own, as it always
-- did: a lock survives a later schedule correction.
--
-- The commissioner fixes a lineup after lock through
-- commissioner_set_lineup_slot, which writes a transactions row for
-- every move. Writing lineup_entries directly does not bypass the lock
-- for anybody, commissioner included.
--
-- Also here: locked_players_to_waivers, a per-league setting (default
-- on). With it on, an unrostered player whose game has kicked off
-- since the league's last waiver run is on waivers until the next one
-- has actually run, rather than a free agent -- the ESPN behaviour.
-- "Actually run" rather than "was scheduled": the hourly job runs late,
-- and a player must not turn free agent at 03:00:00 while claims on him
-- are still waiting to be processed.
-- =====================================================================

alter table public.leagues
  add column if not exists locked_players_to_waivers boolean not null default true;

-- Stamped by process_waivers at the end of every run.
alter table public.leagues
  add column if not exists waivers_processed_at timestamptz;

-- A hold that lasts until the league's next waiver run rather than for
-- a fixed period: a player whose game started while he was unowned.
-- Cleared by the run itself (clear_kickoff_waiver_holds below).
alter table public.waiver_holds
  add column if not exists until_waivers_run boolean not null default false;

-- Who is exempt ---------------------------------------------------------
-- The scheduled jobs run as the service role, with no auth.uid(). A
-- missing role counts as trusted for the same reason as set_player_adp
-- in 0035: that is a direct database connection, not a browser.
create or replace function public.is_trusted_job()
returns boolean
language sql
stable
as $$
  select auth.uid() is null
     and coalesce(
           nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role',
           'service_role'
         ) = 'service_role';
$$;

-- Kickoff times -----------------------------------------------------------
-- A player's game for a week is his NFL team's game that week. No team,
-- or no game (a bye, or a schedule not loaded yet), means no kickoff.
create or replace function public.player_week_kickoff(
  p_season int, p_week int, p_player text
) returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select min(g.kickoff_at)
  from public.nfl_players p
  join public.nfl_games g
    on g.season = p_season
   and g.week   = p_week
   and g.season_type <> 'PRE'
   and p.team_abbr in (g.home_team, g.away_team)
  where p.id = p_player;
$$;

create or replace function public.week_first_kickoff(p_season int, p_week int)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select min(kickoff_at)
  from public.nfl_games
  where season = p_season and week = p_week and season_type <> 'PRE';
$$;

-- When a player's place in a league's lineup locks for a week, per the
-- league's lineup_lock_mode. Null = it does not lock (see the header).
create or replace function public.lineup_lock_time(
  p_league uuid, p_season int, p_week int, p_player text
) returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select case l.lineup_lock_mode
           when 'weekly_kickoff' then public.week_first_kickoff(p_season, p_week)
           else public.player_week_kickoff(p_season, p_week, p_player)
         end
  from public.leagues l
  where l.id = p_league;
$$;

create or replace function public.lineup_player_locked(
  p_league uuid, p_season int, p_week int, p_player text,
  p_locked_at timestamptz default null
) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_locked_at is not null
      or coalesce(
           public.lineup_lock_time(p_league, p_season, p_week, p_player) <= now(),
           false
         );
$$;

-- A slot scores only if the league defines it as a starter. A slot key
-- the league no longer has scores nothing, so it counts as the bench --
-- the same test team_week_points uses.
create or replace function public.is_starter_slot(p_league uuid, p_slot text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select is_starter from public.roster_slots
     where league_id = p_league and slot_key = p_slot),
    false
  );
$$;

-- A lineup row that must not be touched: a locked player in a starting
-- slot. What drops and trades leave behind.
create or replace function public.lineup_entry_frozen(
  p_league uuid, p_season int, p_week int, p_player text,
  p_slot text, p_locked_at timestamptz
) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_starter_slot(p_league, p_slot)
     and public.lineup_player_locked(p_league, p_season, p_week, p_player, p_locked_at);
$$;

-- The trigger -------------------------------------------------------------
create or replace function public.enforce_lineup_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row   public.lineup_entries%rowtype;
  v_mode  text;
  v_name  text;
  v_why   text;
  v_moves boolean;
  v_in    boolean;
  v_out   boolean;
begin
  if public.is_trusted_job() then
    return coalesce(new, old);
  end if;

  -- The commissioner's logged override (commissioner_set_lineup_slot).
  if coalesce(current_setting('app.lineup_override', true), '') = 'on'
     and public.is_commissioner(coalesce(new.league_id, old.league_id)) then
    return coalesce(new, old);
  end if;

  if tg_op = 'UPDATE' and old.locked_at is not null
     and new.locked_at is distinct from old.locked_at then
    raise exception 'A locked lineup spot cannot be unlocked.';
  end if;

  -- Work out whether this write moves somebody into or out of a
  -- starting slot. An update that changes whose row it is counts as
  -- the old row leaving and the new one arriving.
  if tg_op = 'INSERT' then
    v_row := new;
    v_out := false;
    v_in  := public.is_starter_slot(new.league_id, new.slot_key);
  elsif tg_op = 'DELETE' then
    v_row := old;
    v_out := public.is_starter_slot(old.league_id, old.slot_key);
    v_in  := false;
  else
    v_moves := (new.league_id, new.team_id, new.season, new.week, new.player_id)
               is distinct from
               (old.league_id, old.team_id, old.season, old.week, old.player_id);

    if v_moves then
      if public.is_starter_slot(old.league_id, old.slot_key)
         and public.lineup_player_locked(old.league_id, old.season, old.week,
                                         old.player_id, old.locked_at) then
        v_row := old;
        v_out := true;
        v_in  := false;
      else
        v_row := new;
        v_out := false;
        v_in  := public.is_starter_slot(new.league_id, new.slot_key);
      end if;
    elsif new.slot_key is distinct from old.slot_key then
      v_row := old;
      v_out := public.is_starter_slot(old.league_id, old.slot_key);
      v_in  := public.is_starter_slot(new.league_id, new.slot_key);
    else
      return new;
    end if;
  end if;

  if not (v_in or v_out) then
    return coalesce(new, old);
  end if;

  if not public.lineup_player_locked(
       v_row.league_id, v_row.season, v_row.week, v_row.player_id,
       case when tg_op = 'INSERT' then null else v_row.locked_at end) then
    return coalesce(new, old);
  end if;

  select lineup_lock_mode into v_mode from public.leagues where id = v_row.league_id;
  select full_name into v_name from public.nfl_players where id = v_row.player_id;
  v_name := coalesce(v_name, 'That player');

  v_why := case v_mode
             when 'weekly_kickoff'
               then format('the first game of week %s has kicked off, so the lineup is locked',
                           v_row.week)
             else format('his week %s game has kicked off', v_row.week)
           end;

  if v_out then
    raise exception '% is locked: %. He has to stay in the % slot.',
      v_name, v_why, v_row.slot_key;
  else
    raise exception '% is locked: %. He cannot move into the starting lineup.',
      v_name, v_why;
  end if;
end;
$$;

drop trigger if exists lineup_lock_guard on public.lineup_entries;
create trigger lineup_lock_guard
  before insert or update or delete on public.lineup_entries
  for each row execute function public.enforce_lineup_lock();

-- Lock state for the editor ---------------------------------------------
-- Every player on the roster, plus anybody still in the week's lineup
-- (a locked starter who has since been dropped), with when he locks and
-- whether he has.
create or replace function public.lineup_locks(p_team uuid, p_season int, p_week int)
returns table (player_id text, locks_at timestamptz, locked boolean)
language sql
stable
security definer
set search_path = public
as $$
  with t as (
    select id, league_id from public.teams
    where id = p_team
      and (auth.uid() is null or public.is_league_member(league_id))
  ),
  players as (
    select rp.player_id, null::timestamptz as locked_at
    from public.roster_players rp
    join t on t.id = rp.team_id
    where rp.dropped_at is null
    union all
    select le.player_id, le.locked_at
    from public.lineup_entries le
    join t on t.id = le.team_id
    where le.season = p_season and le.week = p_week
  ),
  merged as (
    select players.player_id, max(players.locked_at) as locked_at
    from players group by players.player_id
  )
  select m.player_id,
         public.lineup_lock_time(t.league_id, p_season, p_week, m.player_id),
         public.lineup_player_locked(t.league_id, p_season, p_week,
                                     m.player_id, m.locked_at)
  from merged m cross join t;
$$;

-- The commissioner's override -------------------------------------------
-- One player, one move, one line in the transaction log, which always
-- carries the commissioner's reason: an override with no reason is
-- refused. p_slot null or '' takes him out of the lineup altogether. Validates what the editor
-- validates -- the slot exists, the player is eligible for it, it has
-- room -- because an override is still a lineup, just a late one.
create or replace function public.commissioner_set_lineup_slot(
  p_team uuid, p_week int, p_player text, p_slot text, p_note text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league public.leagues%rowtype;
  v_slot   public.roster_slots%rowtype;
  v_key    text := nullif(trim(coalesce(p_slot, '')), '');
  v_old    text;
  v_name   text;
  v_pos    text;
  v_used   int;
  v_note   text := trim(coalesce(p_note, ''));
begin
  select l.* into v_league
    from public.leagues l
    join public.teams t on t.league_id = l.id
    where t.id = p_team;
  if not found then
    raise exception 'No such team';
  end if;

  if not public.is_commissioner(v_league.id) then
    raise exception 'Only the commissioner can override a lineup';
  end if;

  if v_note = '' then
    raise exception 'Give a reason for the override.';
  end if;
  if length(v_note) > 200 then
    raise exception 'Keep the reason to 200 characters.';
  end if;

  select full_name, position into v_name, v_pos
    from public.nfl_players where id = p_player;
  if not found then
    raise exception 'No such player';
  end if;

  select slot_key into v_old
    from public.lineup_entries
    where team_id = p_team and season = v_league.season
      and week = p_week and player_id = p_player;

  if v_old is null and not exists (
    select 1 from public.roster_players
    where team_id = p_team and player_id = p_player and dropped_at is null
  ) then
    raise exception '% is not on that roster', v_name;
  end if;

  if v_old is not distinct from v_key then
    return;
  end if;

  if v_key is not null then
    select * into v_slot from public.roster_slots
      where league_id = v_league.id and slot_key = v_key;
    if not found then
      raise exception 'Unknown roster slot "%"', v_key;
    end if;

    if cardinality(v_slot.eligible_positions) > 0
       and (v_pos is null or not v_pos = any (v_slot.eligible_positions)) then
      raise exception 'A % cannot play at %', coalesce(v_pos, '?'), v_key;
    end if;

    select count(*) into v_used
      from public.lineup_entries
      where team_id = p_team and season = v_league.season and week = p_week
        and slot_key = v_key and player_id <> p_player;
    if v_used >= v_slot.count then
      raise exception '% is full (% of %). Move somebody out of it first.',
        v_key, v_used, v_slot.count;
    end if;
  end if;

  perform set_config('app.lineup_override', 'on', true);

  if v_key is null then
    delete from public.lineup_entries
      where team_id = p_team and season = v_league.season
        and week = p_week and player_id = p_player;
  else
    insert into public.lineup_entries
      (league_id, team_id, season, week, player_id, slot_key)
    values (v_league.id, p_team, v_league.season, p_week, p_player, v_key)
    on conflict (team_id, season, week, player_id)
      do update set slot_key = excluded.slot_key;
  end if;

  perform set_config('app.lineup_override', '', true);

  insert into public.transactions
    (league_id, team_id, type, player_id, season, week, note, created_by)
  values (
    v_league.id, p_team, 'commissioner', p_player, v_league.season, p_week,
    format('Lineup override, week %s: %s from %s to %s',
           p_week, v_name,
           coalesce(v_old, 'no slot'), coalesce(v_key, 'no slot'))
      || '. Reason: ' || v_note,
    auth.uid()
  );
end;
$$;

-- Waivers for players whose game has started ----------------------------
-- The league's most recent scheduled waiver run at or before p_at, in
-- its own timezone.
create or replace function public.last_waiver_run(
  p_league uuid, p_at timestamptz default now()
) returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  with l as (
    select coalesce(nullif(timezone, ''), 'America/New_York') as tz,
           waiver_process_dow  as dow,
           waiver_process_time as t
    from public.leagues where id = p_league
  ),
  local as (
    select l.*, (p_at at time zone l.tz) as ln from l
  ),
  candidate as (
    select tz, ln,
           date_trunc('day', ln)
             - make_interval(days => ((extract(dow from ln)::int - dow + 7) % 7))
             + t as c
    from local
  )
  select (case when c > ln then c - interval '7 days' else c end) at time zone tz
  from candidate;
$$;

create or replace function public.next_waiver_run(p_league uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select public.last_waiver_run(p_league, now() + interval '7 days');
$$;

-- A game that kicked off after this sends an unowned player to waivers:
-- the last run that actually happened. The schedule stands in only for
-- a league whose waivers have never run.
create or replace function public.waiver_cutoff(p_league uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(l.waivers_processed_at, public.last_waiver_run(l.id))
  from public.leagues l
  where l.id = p_league;
$$;

-- Has this player's game kicked off since the league's last waiver run,
-- in a league that sends such players to waivers? Says nothing about
-- whether he is rostered; callers check that.
create or replace function public.player_locked_to_waivers(p_league uuid, p_player text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select l.locked_players_to_waivers and exists (
      select 1
      from public.nfl_players p
      join public.nfl_games g
        on g.season = l.season
       and g.season_type <> 'PRE'
       and p.team_abbr in (g.home_team, g.away_team)
      where p.id = p_player
        and g.kickoff_at <= now()
        and g.kickoff_at > public.waiver_cutoff(l.id)
    )
    from public.leagues l
    where l.id = p_league
  ), false);
$$;

-- A waiver run ends every until-the-next-run hold in its league: the
-- claims on those players have just been settled, and whoever nobody
-- won is a free agent now. Holds from drops keep their own clock.
create or replace function public.clear_kickoff_waiver_holds()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.waiver_holds
    where league_id = new.id and until_waivers_run;
  return new;
end;
$$;

drop trigger if exists leagues_clear_kickoff_holds on public.leagues;
create trigger leagues_clear_kickoff_holds
  after update of waivers_processed_at on public.leagues
  for each row
  when (new.waivers_processed_at is distinct from old.waivers_processed_at)
  execute function public.clear_kickoff_waiver_holds();

-- Only a waiver run may say when waivers last ran. leagues_update lets
-- the commissioner write any column, and this one is not a setting: set
-- by hand it would clear every kickoff hold with the claims on them
-- still pending, unlogged, and set in the future it would switch the
-- rule off for the season. process_waivers writes it with
-- app.internal_write on; the scheduled jobs are trusted. Guarded on
-- insert too, so a new league cannot start with it set.
create or replace function public.guard_waivers_processed_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(current_setting('app.internal_write', true), '') = 'on'
     or public.is_trusted_job() then
    return new;
  end if;

  if (tg_op = 'INSERT' and new.waivers_processed_at is not null)
     or (tg_op = 'UPDATE'
         and new.waivers_processed_at is distinct from old.waivers_processed_at) then
    raise exception 'Only a waiver run can set waivers_processed_at';
  end if;

  return new;
end;
$$;

drop trigger if exists leagues_guard_waivers_processed_at on public.leagues;
create trigger leagues_guard_waivers_processed_at
  before insert or update on public.leagues
  for each row execute function public.guard_waivers_processed_at();

create or replace function public.player_on_waivers(p_league uuid, p_player text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (auth.uid() is null or public.is_league_member(p_league))
     and (
       exists (
         select 1 from public.waiver_holds
         where league_id = p_league and player_id = p_player and clears_at > now()
       )
       or public.player_locked_to_waivers(p_league, p_player)
     );
$$;

-- add_free_agent, as in 0011, with a clearer refusal for a player whose
-- game has started. He can still be added straight to the bench when
-- the league has locked_players_to_waivers off; the lineup trigger is
-- what stops him being started.
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
  if public.player_locked_to_waivers(v_league, p_player) then
    raise exception 'His game has kicked off, so he is on waivers until waivers next run. Put in a waiver claim instead.';
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

-- Drops and trades leave locked starters where they are ------------------
-- internal_drop, as in 0011, and execute_trade, as in 0022, used to keep
-- rows with locked_at stamped. They now keep exactly the rows the
-- trigger would refuse to delete -- a locked player in a starting slot
-- -- whether or not the job has stamped them, and clear the rest.
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

  -- Pull him out of any lineup he is not locked into.
  delete from public.lineup_entries le
    where le.team_id = p_team and le.player_id = p_player
      and le.season = v_season and le.week >= v_week
      and not public.lineup_entry_frozen(le.league_id, le.season, le.week,
                                         le.player_id, le.slot_key, le.locked_at);

  if v_hours > 0 then
    insert into public.waiver_holds (league_id, player_id, clears_at)
    values (v_league, p_player, now() + make_interval(hours => v_hours))
    -- A drop starts its own clock, even over a leftover kickoff hold.
    on conflict (league_id, player_id)
      do update set clears_at = excluded.clears_at, until_waivers_run = false;
  end if;

  if p_log then
    insert into public.transactions
      (league_id, team_id, type, player_id, season, week, created_by)
    values (v_league, p_team, 'drop', p_player, v_season, v_week, auth.uid());
  end if;
end;
$$;

create or replace function public.execute_trade(p_trade uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trade  public.trades%rowtype;
  v_item   record;
  v_league public.leagues%rowtype;
  v_to     uuid;
begin
  select * into v_trade from public.trades where id = p_trade for update;
  if not found then
    raise exception 'No such trade';
  end if;

  -- Only the two managers involved, or the commissioner, may push it
  -- through. auth.uid() is null for the ingestion jobs, which run under
  -- the service role and are trusted.
  if auth.uid() is not null
     and not public.owns_team(v_trade.proposing_team_id)
     and not public.owns_team(v_trade.receiving_team_id)
     and not public.is_commissioner(v_trade.league_id) then
    raise exception 'That is not your trade';
  end if;

  if v_trade.status <> 'accepted' then
    raise exception 'Only an accepted trade can be executed';
  end if;

  select * into v_league from public.leagues where id = v_trade.league_id;

  perform public.begin_internal_write();

  for v_item in
    select * from public.trade_items where trade_id = p_trade
  loop
    v_to := case when v_item.from_team_id = v_trade.proposing_team_id
                 then v_trade.receiving_team_id
                 else v_trade.proposing_team_id end;

    if v_item.faab_amount is not null then
      update public.teams set faab_remaining = faab_remaining - v_item.faab_amount
        where id = v_item.from_team_id;
      update public.teams set faab_remaining = faab_remaining + v_item.faab_amount
        where id = v_to;
      if (select faab_remaining from public.teams where id = v_item.from_team_id) < 0 then
        raise exception 'That trade would put a team below zero FAAB';
      end if;
    else
      -- Move the player without putting him on waivers.
      update public.roster_players
        set dropped_at = now()
        where team_id = v_item.from_team_id and dropped_at is null
          and player_id = v_item.player_id;

      if not found then
        raise exception 'A traded player is no longer on the sending roster';
      end if;

      delete from public.lineup_entries le
        where le.team_id = v_item.from_team_id and le.player_id = v_item.player_id
          and le.season = v_league.season and le.week >= v_league.current_week
          and not public.lineup_entry_frozen(le.league_id, le.season, le.week,
                                             le.player_id, le.slot_key, le.locked_at);

      insert into public.roster_players (league_id, team_id, player_id, acquired_via)
      values (v_trade.league_id, v_to, v_item.player_id, 'trade');
    end if;

    insert into public.transactions
      (league_id, team_id, related_team_id, type, player_id,
       bid_amount, season, week, note)
    values (v_trade.league_id, v_to, v_item.from_team_id, 'trade',
            v_item.player_id, v_item.faab_amount,
            v_league.season, v_league.current_week, 'Trade');
  end loop;

  update public.trades
    set status = 'completed', completed_at = now()
    where id = p_trade;

  insert into public.league_messages (league_id, user_id, body, is_system)
  values (v_trade.league_id, v_league.commissioner_id,
          'A trade has been completed.', true);
end;
$$;

-- The lock-lineups job ----------------------------------------------------
-- Stamps locked_at on every lineup row whose lock time has passed, by
-- exactly the rule the trigger applies, so the two cannot disagree. The
-- stamp is a record, not the guard: the trigger works without it.
--
-- Also puts unrostered players whose game has started on waivers, as
-- real holds, so the player pool shows them as waiver players with a
-- bid button. They are until-the-next-run holds: the run clears them.
-- clears_at is only a backstop -- a day after the next scheduled run --
-- for a league whose waivers never run. add_free_agent does not rely on
-- the holds; it checks the rule itself.
create or replace function public.apply_kickoff_locks()
returns table (locked int, held int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_locked int;
  v_held   int;
begin
  if not public.is_trusted_job() then
    raise exception 'Only the scheduled jobs can stamp lineup locks';
  end if;

  update public.lineup_entries le
    set locked_at = now()
    where le.locked_at is null
      and public.lineup_lock_time(le.league_id, le.season, le.week, le.player_id) <= now();
  get diagnostics v_locked = row_count;

  insert into public.waiver_holds (league_id, player_id, clears_at, until_waivers_run)
  select distinct l.id, p.id, public.next_waiver_run(l.id) + interval '1 day', true
  from public.leagues l
  join public.nfl_games g
    on g.season = l.season
   and g.season_type <> 'PRE'
   and g.kickoff_at <= now()
  join public.nfl_players p
    on p.team_abbr in (g.home_team, g.away_team)
  where l.locked_players_to_waivers
    and l.status <> 'complete'
    and g.kickoff_at > public.waiver_cutoff(l.id)
    and public.is_fantasy_player(p.id, p.position)
    and not exists (
      select 1 from public.roster_players rp
      where rp.league_id = l.id and rp.player_id = p.id and rp.dropped_at is null
    )
  -- A hold from a drop keeps its own clock.
  on conflict (league_id, player_id)
    do update set clears_at = greatest(public.waiver_holds.clears_at, excluded.clears_at)
    where public.waiver_holds.until_waivers_run;
  get diagnostics v_held = row_count;

  locked := v_locked;
  held := v_held;
  return next;
end;
$$;

-- process_waivers ----------------------------------------------------------
-- As in 0026 (its latest definition), unchanged but for one statement
-- before the return: it records when the run happened, which is the
-- waiver cut-off above and what clears the until-the-next-run holds.
create or replace function public.process_waivers(p_league uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch    uuid := gen_random_uuid();
  v_league   public.leagues%rowtype;
  v_claim    record;
  v_awarded  int := 0;
  v_capacity int;
  v_team_faab int;
  v_max_priority int;
begin
  select * into v_league from public.leagues where id = p_league;
  if not found then
    raise exception 'No such league';
  end if;

  if not (public.is_commissioner(p_league) or auth.uid() is null) then
    raise exception 'Only the commissioner can run waivers';
  end if;

  perform public.begin_internal_write();

  v_capacity := public.roster_capacity(p_league);

  -- Anything whose hold has expired is a plain free agent again.
  delete from public.waiver_holds
    where league_id = p_league and clears_at <= now();

  for v_claim in
    select wc.*, t.waiver_priority, t.faab_remaining
    from public.waiver_claims wc
    join public.teams t on t.id = wc.team_id
    where wc.league_id = p_league and wc.status = 'pending'
    order by
      case when v_league.waiver_type = 'faab' then wc.bid_amount end desc nulls last,
      case when v_league.waiver_type = 'priority'
             or v_league.faab_tie_breaker = 'waiver_priority'
           then t.waiver_priority end asc nulls last,
      case when v_league.faab_tie_breaker = 'earliest_bid' then wc.created_at end asc nulls last,
      case when v_league.faab_tie_breaker = 'random' then random() end asc nulls last,
      wc.claim_priority asc,
      wc.created_at asc
  loop
    -- Re-read the budget; an earlier award in this batch may have spent it.
    select faab_remaining into v_team_faab
      from public.teams where id = v_claim.team_id;

    if not public.player_is_free(p_league, v_claim.add_player_id) then
      update public.waiver_claims
        set status = 'lost', result_note = 'Player was claimed by another team',
            processed_at = now(), processed_batch = v_batch
        where id = v_claim.id;
      continue;
    end if;

    if v_league.waiver_type = 'faab' and v_claim.bid_amount > v_team_faab then
      update public.waiver_claims
        set status = 'invalid', result_note = 'Not enough FAAB remaining',
            processed_at = now(), processed_batch = v_batch
        where id = v_claim.id;
      continue;
    end if;

    -- The paired drop happens first so the roster has room.
    if v_claim.drop_player_id is not null then
      begin
        perform public.internal_drop(v_claim.team_id, v_claim.drop_player_id, true);
      exception when others then
        update public.waiver_claims
          set status = 'invalid', result_note = 'Drop failed: ' || sqlerrm,
              processed_at = now(), processed_batch = v_batch
          where id = v_claim.id;
        continue;
      end;
    end if;

    if public.roster_size(v_claim.team_id) >= v_capacity then
      update public.waiver_claims
        set status = 'invalid', result_note = 'Roster full',
            processed_at = now(), processed_batch = v_batch
        where id = v_claim.id;
      continue;
    end if;

    -- The award below runs with app.internal_write on, so the position
    -- limit trigger will not fire. Check it here instead: a claim that
    -- would breach the limit is marked invalid, rather than throwing and
    -- abandoning the rest of the batch.
    if public.would_exceed_position_limit(
         v_claim.team_id, v_claim.add_player_id) then
      update public.waiver_claims
        set status = 'invalid',
            result_note = 'Would exceed the limit for that position',
            processed_at = now(), processed_batch = v_batch
        where id = v_claim.id;
      continue;
    end if;

    -- Award it.
    insert into public.roster_players (league_id, team_id, player_id, acquired_via)
    values (p_league, v_claim.team_id, v_claim.add_player_id, 'waiver');

    delete from public.waiver_holds
      where league_id = p_league and player_id = v_claim.add_player_id;

    if v_league.waiver_type = 'faab' then
      update public.teams
        set faab_remaining = faab_remaining - v_claim.bid_amount
        where id = v_claim.team_id;
    else
      -- Winner goes to the back of the waiver order.
      select coalesce(max(waiver_priority), 0) into v_max_priority
        from public.teams where league_id = p_league;
      update public.teams
        set waiver_priority = waiver_priority - 1
        where league_id = p_league and waiver_priority > v_claim.waiver_priority;
      update public.teams
        set waiver_priority = v_max_priority
        where id = v_claim.team_id;
    end if;

    update public.waiver_claims
      set status = 'won', result_note = 'Claim awarded',
          processed_at = now(), processed_batch = v_batch
      where id = v_claim.id;

    insert into public.transactions
      (league_id, team_id, type, player_id, bid_amount, season, week, note)
    values (p_league, v_claim.team_id, 'waiver_add', v_claim.add_player_id,
            v_claim.bid_amount, v_league.season, v_league.current_week,
            case when v_league.waiver_type = 'faab'
                 then 'Won on a $' || v_claim.bid_amount || ' bid'
                 else 'Won on waiver priority' end);

    v_awarded := v_awarded + 1;
  end loop;

  -- Anything still pending lost out.
  update public.waiver_claims
    set status = 'lost', result_note = coalesce(nullif(result_note, ''), 'Outbid'),
        processed_at = now(), processed_batch = v_batch
    where league_id = p_league and status = 'pending';

  insert into public.league_messages (league_id, user_id, body, is_system)
  select p_league, v_league.commissioner_id,
         'Waivers processed: ' || v_awarded || ' claim(s) awarded.', true;

  update public.leagues set waivers_processed_at = now() where id = p_league;

  return v_awarded;
end;
$$;

-- Grants ------------------------------------------------------------------
-- Postgres grants EXECUTE on every new function to PUBLIC, and a revoke
-- from authenticated and anon alone leaves that in place -- which is how
-- internal_drop (0011) stayed callable by any signed-in user, against
-- any team. So every function here states PUBLIC explicitly.
--
-- Internal: reached only from SECURITY DEFINER code or the trigger, or
-- by the scheduled jobs under the service role (granted separately by
-- Supabase, as in 0038).
revoke execute on function public.is_trusted_job()                               from public, anon, authenticated;
revoke execute on function public.player_week_kickoff(int, int, text)            from public, anon, authenticated;
revoke execute on function public.week_first_kickoff(int, int)                   from public, anon, authenticated;
revoke execute on function public.lineup_lock_time(uuid, int, int, text)         from public, anon, authenticated;
revoke execute on function public.lineup_player_locked(uuid, int, int, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.is_starter_slot(uuid, text)                    from public, anon, authenticated;
revoke execute on function public.lineup_entry_frozen(uuid, int, int, text, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.enforce_lineup_lock()                          from public, anon, authenticated;
revoke execute on function public.last_waiver_run(uuid, timestamptz)             from public, anon, authenticated;
revoke execute on function public.next_waiver_run(uuid)                          from public, anon, authenticated;
revoke execute on function public.waiver_cutoff(uuid)                            from public, anon, authenticated;
revoke execute on function public.player_locked_to_waivers(uuid, text)           from public, anon, authenticated;
revoke execute on function public.clear_kickoff_waiver_holds()                   from public, anon, authenticated;
revoke execute on function public.guard_waivers_processed_at()                   from public, anon, authenticated;
revoke execute on function public.apply_kickoff_locks()                          from public, anon, authenticated;
revoke execute on function public.internal_drop(uuid, text, boolean)             from public, anon, authenticated;

-- Signed-in users only; each checks who is calling.
revoke execute on function public.lineup_locks(uuid, int, int)                   from public, anon;
grant  execute on function public.lineup_locks(uuid, int, int)                   to authenticated;
revoke execute on function public.commissioner_set_lineup_slot(uuid, int, text, text, text) from public, anon;
grant  execute on function public.commissioner_set_lineup_slot(uuid, int, text, text, text) to authenticated;
revoke execute on function public.player_on_waivers(uuid, text)                  from public, anon;
grant  execute on function public.player_on_waivers(uuid, text)                  to authenticated;
revoke execute on function public.add_free_agent(uuid, text, text)               from public, anon;
grant  execute on function public.add_free_agent(uuid, text, text)               to authenticated;
-- execute_trade lets a caller with no auth.uid() through as a trusted
-- job, so anon must not reach it at all.
revoke execute on function public.execute_trade(uuid)                            from public, anon;
grant  execute on function public.execute_trade(uuid)                            to authenticated;
revoke execute on function public.process_waivers(uuid)                          from public, anon;
grant  execute on function public.process_waivers(uuid)                          to authenticated;
