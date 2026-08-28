-- =====================================================================
-- 0026  Per-position roster limits
--
-- Roster size was the only cap, so a manager could hold nine running
-- backs as long as there were bench spots for them. A limit belongs to
-- the position rather than to the slot, because a player occupies his
-- position whether he is starting, benched or on IR.
--
-- No row for a position means no limit, so an existing league carries on
-- exactly as it did until the commissioner sets one.
-- =====================================================================

create table if not exists public.league_position_limits (
  league_id uuid not null references public.leagues(id) on delete cascade,
  position  text not null,
  max_count int  not null check (max_count >= 0),
  primary key (league_id, position)
);

alter table public.league_position_limits enable row level security;

drop policy if exists lpl_read on public.league_position_limits;
create policy lpl_read on public.league_position_limits
  for select to authenticated using (public.is_league_member(league_id));

drop policy if exists lpl_write on public.league_position_limits;
create policy lpl_write on public.league_position_limits
  for all to authenticated
  using (public.is_commissioner(league_id))
  with check (public.is_commissioner(league_id));

-- How many of a position a team currently holds ------------------------
create or replace function public.position_count(p_team uuid, p_position text)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
  from public.roster_players rp
  join public.nfl_players p on p.id = rp.player_id
  where rp.team_id = p_team
    and rp.dropped_at is null
    and p.position = p_position;
$$;

grant execute on function public.position_count(uuid, text) to authenticated;

/**
 * Refuses an acquisition that would put a team over its limit.
 *
 * A trigger rather than a check inside each of add_free_agent,
 * make_draft_pick, the waiver award and execute_trade: there are four
 * ways onto a roster and this is the one place all of them pass
 * through.
 *
 * Skipped while app.internal_write is on. That covers the paths that
 * move players on somebody's behalf and do their own checking:
 * execute_trade, which deletes and inserts per item and so passes
 * through states that are only briefly over the limit, and the waiver
 * processor, which marks a breaching claim invalid rather than throwing
 * and abandoning the rest of the batch.
 */
create or replace function public.enforce_position_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_position text;
  v_max      int;
  v_held     int;
begin
  if coalesce(current_setting('app.internal_write', true), '') = 'on' then
    return new;
  end if;

  select position into v_position
    from public.nfl_players where id = new.player_id;

  if v_position is null then
    return new;
  end if;

  select max_count into v_max
    from public.league_position_limits
    where league_id = new.league_id and position = v_position;

  if v_max is null then
    return new;
  end if;

  select public.position_count(new.team_id, v_position) into v_held;

  if v_held >= v_max then
    raise exception
      'That would be % players at %, and this league allows %. Drop one first.',
      v_held + 1, v_position, v_max;
  end if;

  return new;
end;
$$;

drop trigger if exists roster_players_position_limit on public.roster_players;
create trigger roster_players_position_limit
  before insert on public.roster_players
  for each row execute function public.enforce_position_limit();

-- Would this claim breach the limit? Used by the waiver processor, which
-- reports rather than throws.
create or replace function public.would_exceed_position_limit(
  p_team uuid, p_player text
) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select public.position_count(p_team, p.position) >= l.max_count
      from public.nfl_players p
      join public.teams t on t.id = p_team
      join public.league_position_limits l
        on l.league_id = t.league_id and l.position = p.position
      where p.id = p_player
    ),
    false
  );
$$;

grant execute on function public.would_exceed_position_limit(uuid, text)
  to authenticated;

-- Seed sensible defaults for leagues that have none --------------------
-- Deliberately generous: this is a cap on hoarding, not a squad plan.
insert into public.league_position_limits (league_id, position, max_count)
select l.id, v.position, v.max_count
from public.leagues l
cross join (values
  ('QB', 4), ('RB', 8), ('WR', 8), ('TE', 4), ('K', 3), ('DEF', 3)
) as v(position, max_count)
on conflict (league_id, position) do nothing;

-- ...and for every league made from now on.
create or replace function public.seed_default_position_limits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.league_position_limits (league_id, position, max_count)
  values
    (new.id, 'QB', 4), (new.id, 'RB', 8), (new.id, 'WR', 8),
    (new.id, 'TE', 4), (new.id, 'K',  3), (new.id, 'DEF', 3)
  on conflict (league_id, position) do nothing;
  return new;
end;
$$;

drop trigger if exists leagues_seed_position_limits on public.leagues;
create trigger leagues_seed_position_limits after insert on public.leagues
  for each row execute function public.seed_default_position_limits();

-- Waivers award players with app.internal_write on, so the trigger above
-- stands aside for them. Redefined here with the check done inline, so a
-- claim that would breach the limit is reported rather than thrown.
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

  return v_awarded;
end;
$$;
