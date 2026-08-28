-- =====================================================================
-- 0022  Check who is executing a trade
--
-- execute_trade only checked that the trade was in the 'accepted'
-- state, not that the caller had anything to do with it. It is a
-- SECURITY DEFINER function, so anyone who could guess a trade id could
-- push an accepted trade through.
--
-- The practical impact was small -- executing an accepted trade only
-- does what both managers already agreed to -- but a trade can sit in
-- 'accepted' between the two statements the app issues, and an
-- unauthorised write is an unauthorised write.
-- =====================================================================

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
