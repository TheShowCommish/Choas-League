-- =====================================================================
-- 0019  Auction draft
--
-- A snake draft has a fixed board, so 0014 pre-creates every pick. An
-- auction does not: a team's picks are whatever it wins, so pick rows
-- are inserted as lots close. generate_draft is replaced below to skip
-- board generation for auction drafts.
--
-- The rule that shapes everything here is that a team must always be
-- able to fill its roster: you may never bid so much that you cannot
-- afford $1 for each remaining empty slot.
-- =====================================================================

-- What a team has left to spend -----------------------------------------
create or replace function public.auction_budget_left(p_draft uuid, p_team uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select d.auction_budget - coalesce((
    select sum(p.bid_amount) from public.draft_picks p
    where p.draft_id = p_draft and p.team_id = p_team
  ), 0)
  from public.drafts d where d.id = p_draft;
$$;

-- The most a team may bid right now --------------------------------------
-- Budget left, minus a dollar held back for every slot after this one.
create or replace function public.auction_max_bid(p_draft uuid, p_team uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select greatest(
    public.auction_budget_left(p_draft, p_team)
      - greatest(
          d.rounds - (
            select count(*)::int from public.draft_picks p
            where p.draft_id = p_draft and p.team_id = p_team
          ) - 1,
          0
        ),
    0
  )
  from public.drafts d where d.id = p_draft;
$$;

/**
 * Whose turn it is to nominate.
 *
 * Nomination cycles through the draft order by lot count, so with four
 * teams the 5th nomination comes back round to the first team.
 */
create or replace function public.auction_nominator(p_draft uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  with ordered as (
    select team_id, row_number() over (order by position) - 1 as idx
    from public.draft_order where draft_id = p_draft
  ),
  lot_count as (
    select count(*) as n from public.auction_lots where draft_id = p_draft
  )
  select o.team_id
  from ordered o, lot_count l
  where o.idx = l.n % (select count(*) from ordered);
$$;

-- Put a player up for bid -------------------------------------------------
create or replace function public.nominate_player(
  p_draft uuid, p_player text, p_opening_bid int default 1
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_draft     public.drafts%rowtype;
  v_nominator uuid;
  v_lot_id    uuid;
begin
  select * into v_draft from public.drafts where id = p_draft for update;
  if not found then raise exception 'No such draft'; end if;
  if v_draft.type <> 'auction' then
    raise exception 'That draft is not an auction';
  end if;
  if v_draft.status <> 'live' then
    raise exception 'The draft is not live';
  end if;

  if exists (
    select 1 from public.auction_lots
    where draft_id = p_draft and status = 'open'
  ) then
    raise exception 'There is already a player up for bid';
  end if;

  v_nominator := public.auction_nominator(p_draft);

  if not public.owns_team(v_nominator)
     and not public.is_commissioner(v_draft.league_id) then
    raise exception 'It is not your turn to nominate';
  end if;

  if not public.player_is_free(v_draft.league_id, p_player) then
    raise exception 'That player has already been drafted';
  end if;

  if p_opening_bid < 1 then
    raise exception 'The opening bid must be at least $1';
  end if;
  if p_opening_bid > public.auction_max_bid(p_draft, v_nominator) then
    raise exception 'That opening bid would leave you unable to fill your roster';
  end if;

  insert into public.auction_lots
    (draft_id, player_id, nominated_by, high_bid, high_bidder_id, closes_at)
  values (
    p_draft, p_player, v_nominator, p_opening_bid, v_nominator,
    now() + make_interval(secs => v_draft.seconds_per_bid)
  )
  returning id into v_lot_id;

  insert into public.auction_bids (lot_id, team_id, amount)
  values (v_lot_id, v_nominator, p_opening_bid);

  return v_lot_id;
end;
$$;

-- Bid on the open lot ------------------------------------------------------
create or replace function public.place_bid(
  p_lot uuid, p_team uuid, p_amount int
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lot   public.auction_lots%rowtype;
  v_draft public.drafts%rowtype;
begin
  select * into v_lot from public.auction_lots where id = p_lot for update;
  if not found then raise exception 'No such lot'; end if;
  if v_lot.status <> 'open' then raise exception 'That lot is closed'; end if;

  select * into v_draft from public.drafts where id = v_lot.draft_id;
  if v_draft.status <> 'live' then
    raise exception 'The draft is not live';
  end if;

  if not public.owns_team(p_team) then
    raise exception 'That is not your team';
  end if;

  if p_amount <= v_lot.high_bid then
    raise exception 'The bid is already $%', v_lot.high_bid;
  end if;
  if p_amount > public.auction_max_bid(v_lot.draft_id, p_team) then
    raise exception 'That bid would leave you unable to fill your roster';
  end if;
  if public.roster_size(p_team) >= public.roster_capacity(v_draft.league_id) then
    raise exception 'Your roster is full';
  end if;

  insert into public.auction_bids (lot_id, team_id, amount)
  values (p_lot, p_team, p_amount);

  -- Every bid resets the clock, so a late bid cannot sneak through.
  update public.auction_lots
    set high_bid = p_amount,
        high_bidder_id = p_team,
        closes_at = now() + make_interval(secs => v_draft.seconds_per_bid)
    where id = p_lot;

  return p_amount;
end;
$$;

-- Award the lot to the high bidder ----------------------------------------
-- Called when the clock runs out. Re-checks the deadline itself, so
-- several browsers racing to call it is harmless.
create or replace function public.close_auction_lot(p_lot uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lot     public.auction_lots%rowtype;
  v_draft   public.drafts%rowtype;
  v_league  public.leagues%rowtype;
  v_pick_no int;
  v_round   int;
begin
  select * into v_lot from public.auction_lots where id = p_lot for update;
  if not found or v_lot.status <> 'open' then return null; end if;
  if v_lot.closes_at is null or v_lot.closes_at > now() then return null; end if;

  select * into v_draft from public.drafts where id = v_lot.draft_id;
  select * into v_league from public.leagues where id = v_draft.league_id;

  if v_lot.high_bidder_id is null then
    update public.auction_lots
      set status = 'passed', closed_at = now() where id = p_lot;
    return null;
  end if;

  perform public.begin_internal_write();

  select coalesce(max(pick_number), 0) + 1 into v_pick_no
    from public.draft_picks where draft_id = v_lot.draft_id;

  select count(*)::int + 1 into v_round
    from public.draft_picks
    where draft_id = v_lot.draft_id and team_id = v_lot.high_bidder_id;

  insert into public.draft_picks
    (draft_id, league_id, pick_number, round, round_pick, team_id,
     player_id, bid_amount, picked_at)
  values (v_lot.draft_id, v_draft.league_id, v_pick_no, v_round, v_pick_no,
          v_lot.high_bidder_id, v_lot.player_id, v_lot.high_bid, now());

  insert into public.roster_players (league_id, team_id, player_id, acquired_via)
  values (v_draft.league_id, v_lot.high_bidder_id, v_lot.player_id, 'draft');

  insert into public.transactions
    (league_id, team_id, type, player_id, bid_amount, season, week, note)
  values (v_draft.league_id, v_lot.high_bidder_id, 'draft', v_lot.player_id,
          v_lot.high_bid, v_league.season, 0,
          'Won at auction for $' || v_lot.high_bid);

  delete from public.draft_queue where player_id = v_lot.player_id;

  update public.auction_lots
    set status = 'sold', closed_at = now() where id = p_lot;

  -- The draft ends once every team has filled its rounds.
  if not exists (
    select 1 from public.draft_order o
    where o.draft_id = v_lot.draft_id
      and (
        select count(*) from public.draft_picks p
        where p.draft_id = v_lot.draft_id and p.team_id = o.team_id
      ) < v_draft.rounds
  ) then
    update public.drafts
      set status = 'complete', completed_at = now() where id = v_lot.draft_id;
    update public.leagues
      set status = 'in_season' where id = v_draft.league_id;
  end if;

  return v_lot.high_bidder_id;
end;
$$;

-- generate_draft, now aware that an auction has no pre-built board -------
create or replace function public.generate_draft(
  p_league uuid, p_randomize boolean default true
) returns uuid
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
  delete from public.auction_lots where draft_id = v_draft.id;

  -- An auction has no fixed board: picks appear as lots are won.
  if v_draft.type = 'snake' then
    for v_round in 1..v_draft.rounds loop
      for v_slot in 1..v_n loop
        v_pick_no := v_pick_no + 1;
        if v_round % 2 = 0 then
          v_team := v_teams[v_n + 1 - v_slot];
        else
          v_team := v_teams[v_slot];
        end if;

        insert into public.draft_picks
          (draft_id, league_id, pick_number, round, round_pick, team_id)
        values (v_draft.id, p_league, v_pick_no, v_round, v_slot, v_team);
      end loop;
    end loop;
  end if;

  update public.drafts
    set current_pick_number = 1, status = 'scheduled',
        started_at = null, completed_at = null, pick_deadline = null
    where id = v_draft.id;

  return v_draft.id;
end;
$$;

grant execute on function public.auction_budget_left(uuid, uuid)   to authenticated;
grant execute on function public.auction_max_bid(uuid, uuid)       to authenticated;
grant execute on function public.auction_nominator(uuid)           to authenticated;
grant execute on function public.nominate_player(uuid, text, int)  to authenticated;
grant execute on function public.place_bid(uuid, uuid, int)        to authenticated;
grant execute on function public.close_auction_lot(uuid)           to authenticated;
