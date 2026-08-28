-- =====================================================================
-- 0013  Waiver processing + schedule generation
-- =====================================================================

-- Process every pending claim in a league ------------------------------
--
-- FAAB: highest bid wins, ties broken by the league's configured rule.
-- Priority: lowest waiver_priority wins, and the winner drops to the
-- back of the order.
--
-- Claims are resolved greedily in that order. A claim can still fail
-- after winning the ordering -- the team may have run out of FAAB or
-- roster space on an earlier claim in the same batch -- so every claim
-- is re-validated at the moment it is awarded.
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

  return v_awarded;
end;
$$;

-- Round-robin schedule generation ---------------------------------------
--
-- Standard circle method: fix one team, rotate the rest. With an odd
-- number of teams a null placeholder rotates through, giving each team
-- exactly one bye week.
create or replace function public.generate_schedule(p_league uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league   public.leagues%rowtype;
  v_ids      uuid[];
  v_n        int;
  v_week     int;
  v_i        int;
  v_home     uuid;
  v_away     uuid;
  v_created  int := 0;
  v_rot      uuid[];
begin
  select * into v_league from public.leagues where id = p_league;
  if not public.is_commissioner(p_league) then
    raise exception 'Only the commissioner can generate the schedule';
  end if;

  select array_agg(id order by created_at) into v_ids
    from public.teams where league_id = p_league;

  if coalesce(array_length(v_ids, 1), 0) < 2 then
    raise exception 'Need at least two teams to build a schedule';
  end if;

  -- Pad to an even count with a null "bye" slot.
  if array_length(v_ids, 1) % 2 = 1 then
    v_ids := v_ids || array[null::uuid];
  end if;
  v_n := array_length(v_ids, 1);

  delete from public.matchups
    where league_id = p_league and season = v_league.season and is_playoff = false;

  v_rot := v_ids;

  for v_week in 1..v_league.regular_season_weeks loop
    for v_i in 1..(v_n / 2) loop
      v_home := v_rot[v_i];
      v_away := v_rot[v_n + 1 - v_i];

      -- Alternate home and away by week so it stays roughly even.
      if v_week % 2 = 0 then
        v_home := v_rot[v_n + 1 - v_i];
        v_away := v_rot[v_i];
      end if;

      -- A pairing against the null placeholder is that team's bye.
      if v_home is null then
        v_home := v_away;
        v_away := null;
      end if;

      if v_home is not null then
        insert into public.matchups
          (league_id, season, week, home_team_id, away_team_id)
        values (p_league, v_league.season, v_week, v_home, v_away)
        on conflict (league_id, season, week, home_team_id) do nothing;
        v_created := v_created + 1;
      end if;
    end loop;

    -- Rotate everything but the first entry.
    v_rot := array[v_rot[1]] || v_rot[v_n:v_n] || v_rot[2:v_n - 1];
  end loop;

  return v_created;
end;
$$;

grant execute on function public.process_waivers(uuid)   to authenticated;
grant execute on function public.generate_schedule(uuid) to authenticated;
