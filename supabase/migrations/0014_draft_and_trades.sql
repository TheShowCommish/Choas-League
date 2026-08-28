-- =====================================================================
-- 0014  Draft operations + trade execution
-- =====================================================================

-- Build the board -------------------------------------------------------
-- Pre-creates every pick slot so the draft grid renders in full and
-- "who is on the clock" is one indexed lookup rather than a computation.
create or replace function public.generate_draft(p_league uuid, p_randomize boolean default true)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_draft    public.drafts%rowtype;
  v_teams    uuid[];
  v_n        int;
  v_round    int;
  v_slot     int;
  v_pick_no  int := 0;
  v_team     uuid;
begin
  if not public.is_commissioner(p_league) then
    raise exception 'Only the commissioner can generate the draft';
  end if;

  select * into v_draft from public.drafts where league_id = p_league;
  if not found then
    insert into public.drafts (league_id) values (p_league) returning * into v_draft;
  end if;

  if v_draft.status = 'complete' then
    raise exception 'That draft is already complete';
  end if;

  if p_randomize then
    select array_agg(id order by random()) into v_teams
      from public.teams where league_id = p_league;
    delete from public.draft_order where draft_id = v_draft.id;
    for v_slot in 1..coalesce(array_length(v_teams, 1), 0) loop
      insert into public.draft_order (draft_id, team_id, position)
      values (v_draft.id, v_teams[v_slot], v_slot);
    end loop;
  else
    select array_agg(team_id order by position) into v_teams
      from public.draft_order where draft_id = v_draft.id;
  end if;

  v_n := coalesce(array_length(v_teams, 1), 0);
  if v_n < 2 then
    raise exception 'Need at least two teams to draft';
  end if;

  delete from public.draft_picks where draft_id = v_draft.id;

  for v_round in 1..v_draft.rounds loop
    for v_slot in 1..v_n loop
      v_pick_no := v_pick_no + 1;
      -- Snake: even rounds run back down the order.
      if v_draft.type = 'snake' and v_round % 2 = 0 then
        v_team := v_teams[v_n + 1 - v_slot];
      else
        v_team := v_teams[v_slot];
      end if;

      insert into public.draft_picks
        (draft_id, league_id, pick_number, round, round_pick, team_id)
      values (v_draft.id, p_league, v_pick_no, v_round, v_slot, v_team);
    end loop;
  end loop;

  update public.drafts
    set current_pick_number = 1, status = 'scheduled',
        started_at = null, completed_at = null, pick_deadline = null
    where id = v_draft.id;

  return v_draft.id;
end;
$$;

-- Make a pick -----------------------------------------------------------
create or replace function public.make_draft_pick(
  p_draft    uuid,
  p_player   text,
  p_autopick boolean default false
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_draft  public.drafts%rowtype;
  v_pick   public.draft_picks%rowtype;
  v_league public.leagues%rowtype;
begin
  select * into v_draft from public.drafts where id = p_draft for update;
  if not found then
    raise exception 'No such draft';
  end if;
  if v_draft.status <> 'live' then
    raise exception 'The draft is not live';
  end if;

  select * into v_league from public.leagues where id = v_draft.league_id;

  select * into v_pick from public.draft_picks
    where draft_id = p_draft and pick_number = v_draft.current_pick_number;
  if not found then
    raise exception 'The draft is already over';
  end if;

  -- Only the team on the clock picks, unless the commissioner is
  -- stepping in or the clock ran out and autopick fired.
  if not p_autopick
     and not public.owns_team(v_pick.team_id)
     and not public.is_commissioner(v_draft.league_id) then
    raise exception 'It is not your pick';
  end if;

  if not public.player_is_free(v_draft.league_id, p_player) then
    raise exception 'That player has already been drafted';
  end if;

  update public.draft_picks
    set player_id = p_player, is_autopick = p_autopick, picked_at = now()
    where id = v_pick.id;

  insert into public.roster_players (league_id, team_id, player_id, acquired_via)
  values (v_draft.league_id, v_pick.team_id, p_player, 'draft');

  insert into public.transactions
    (league_id, team_id, type, player_id, season, week, note)
  values (v_draft.league_id, v_pick.team_id, 'draft', p_player,
          v_league.season, 0,
          'Round ' || v_pick.round || ', pick ' || v_pick.round_pick
          || case when p_autopick then ' (autopick)' else '' end);

  -- Drop the player out of everyone's queue so autopick can't re-take him.
  delete from public.draft_queue where player_id = p_player;

  -- Advance the clock.
  if exists (select 1 from public.draft_picks
             where draft_id = p_draft and pick_number = v_draft.current_pick_number + 1) then
    update public.drafts
      set current_pick_number = current_pick_number + 1,
          pick_deadline = now() + make_interval(secs => v_draft.seconds_per_pick)
      where id = p_draft;
  else
    update public.drafts
      set status = 'complete', completed_at = now(), pick_deadline = null
      where id = p_draft;
    update public.leagues set status = 'in_season' where id = v_draft.league_id;
  end if;

  return v_pick.pick_number;
end;
$$;

-- Autopick: the team's queue first, then best available by last season's
-- fantasy points in this league's own scoring.
create or replace function public.autopick(p_draft uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_draft   public.drafts%rowtype;
  v_pick    public.draft_picks%rowtype;
  v_player  text;
begin
  select * into v_draft from public.drafts where id = p_draft;
  if v_draft.status <> 'live' or not v_draft.autopick_enabled then
    return null;
  end if;
  if v_draft.pick_deadline is null or v_draft.pick_deadline > now() then
    return null;
  end if;

  select * into v_pick from public.draft_picks
    where draft_id = p_draft and pick_number = v_draft.current_pick_number;

  select q.player_id into v_player
    from public.draft_queue q
    where q.team_id = v_pick.team_id
      and public.player_is_free(v_draft.league_id, q.player_id)
    order by q.rank
    limit 1;

  if v_player is null then
    select p.id into v_player
      from public.nfl_players p
      left join public.player_season_points sp
        on sp.player_id = p.id and sp.league_id = v_draft.league_id
      where p.position in ('QB','RB','WR','TE','K','DEF')
        and public.player_is_free(v_draft.league_id, p.id)
      order by coalesce(sp.total_points, 0) desc, p.full_name
      limit 1;
  end if;

  if v_player is null then
    return null;
  end if;

  return public.make_draft_pick(p_draft, v_player, true);
end;
$$;

-- Execute an accepted trade ---------------------------------------------
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
  if v_trade.status <> 'accepted' then
    raise exception 'Only an accepted trade can be executed';
  end if;

  perform public.begin_internal_write();

  select * into v_league from public.leagues where id = v_trade.league_id;

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

      delete from public.lineup_entries
        where team_id = v_item.from_team_id and player_id = v_item.player_id
          and season = v_league.season and week >= v_league.current_week
          and locked_at is null;

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

grant execute on function public.generate_draft(uuid, boolean)                to authenticated;
grant execute on function public.make_draft_pick(uuid, text, boolean)         to authenticated;
grant execute on function public.autopick(uuid)                               to authenticated;
grant execute on function public.execute_trade(uuid)                          to authenticated;
