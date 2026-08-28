-- =====================================================================
-- 0023  Authorisation checks on the remaining SECURITY DEFINER functions
--
-- An audit of everything granted to `authenticated` turned up several
-- functions that took a league or draft id and never checked whether
-- the caller had anything to do with it:
--
--   recompute_week_scores / recompute_matchup_scores
--       Rewrote player_week_scores and matchups for any league. The
--       result is correct either way, so this was not corrupting --
--       but it is an unauthorised write and a free way to make the
--       database do a lot of work.
--
--   team_week_points
--       Returned every team's weekly total for any league.
--
--   autopick / close_auction_lot
--       Advanced somebody else's draft. Both only act once the clock
--       has expired, so the effect was one that was going to happen
--       anyway, but there is no reason to let a stranger drive it.
--
-- Throughout, `auth.uid() is null` still passes: that is the ingestion
-- jobs running under the service role, which are trusted.
-- =====================================================================

create or replace function public.team_week_points(
  p_league uuid, p_season int, p_week int
) returns table (team_id uuid, points numeric)
language sql
stable
security definer
set search_path = public
as $$
  select le.team_id,
         round(sum(coalesce(pws.points, 0)), 2) as points
  from public.lineup_entries le
  join public.roster_slots rs
    on rs.league_id = p_league
   and rs.slot_key  = le.slot_key
   and rs.is_starter
  left join public.player_week_scores pws
    on pws.league_id = p_league
   and pws.season    = le.season
   and pws.week      = le.week
   and pws.player_id = le.player_id
  where le.league_id = p_league
    and le.season    = p_season
    and le.week      = p_week
    and (auth.uid() is null or public.is_league_member(p_league))
  group by le.team_id;
$$;

create or replace function public.recompute_matchup_scores(
  p_league uuid, p_season int, p_week int
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not public.is_commissioner(p_league) then
    raise exception 'Only the commissioner can recompute scores';
  end if;

  -- Teams with no lineup at all still need their score zeroed out.
  update public.matchups
    set home_score = 0, away_score = 0
    where league_id = p_league and season = p_season and week = p_week
      and status <> 'final';

  update public.matchups m
    set home_score = tp.points
    from public.team_week_points(p_league, p_season, p_week) tp
    where m.league_id = p_league and m.season = p_season and m.week = p_week
      and m.status <> 'final'
      and m.home_team_id = tp.team_id;

  update public.matchups m
    set away_score = tp.points
    from public.team_week_points(p_league, p_season, p_week) tp
    where m.league_id = p_league and m.season = p_season and m.week = p_week
      and m.status <> 'final'
      and m.away_team_id = tp.team_id;
end;
$$;

-- Same guard on the outer function, so the failure is reported before
-- the expensive scoring join rather than after it.
create or replace function public.recompute_week_scores(
  p_league uuid, p_season int, p_week int
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int := 0;
begin
  if auth.uid() is not null and not public.is_commissioner(p_league) then
    raise exception 'Only the commissioner can recompute scores';
  end if;

  with scored as (
    select
      pgs.player_id,
      pgs.season,
      pgs.week,
      bool_and(pgs.source = 'final')                as is_final,
      sum(public.safe_numeric(kv.value) * r.points) as points,
      jsonb_object_agg(
        kv.key,
        jsonb_build_object(
          'value',  public.safe_numeric(kv.value),
          'points', round(public.safe_numeric(kv.value) * r.points, 2)
        )
      )                                             as breakdown
    from public.player_game_stats pgs
    join public.nfl_players pl on pl.id = pgs.player_id
    cross join lateral jsonb_each_text(pgs.stats) as kv(key, value)
    join public.league_scoring_rules r
      on r.league_id = p_league
     and r.stat_key  = kv.key
     and r.points   <> 0
     and (cardinality(r.positions) = 0 or pl.position = any(r.positions))
    where pgs.season = p_season
      and pgs.week   = p_week
      and public.safe_numeric(kv.value) is not null
      and public.safe_numeric(kv.value) <> 0
    group by pgs.player_id, pgs.season, pgs.week
  )
  insert into public.player_week_scores
    (league_id, player_id, season, week, points, breakdown, is_final, computed_at)
  select p_league, player_id, season, week,
         round(coalesce(points, 0), 2), coalesce(breakdown, '{}'::jsonb),
         is_final, now()
  from scored
  on conflict (league_id, player_id, season, week)
  do update set
    points      = excluded.points,
    breakdown   = excluded.breakdown,
    is_final    = excluded.is_final,
    computed_at = now();

  get diagnostics v_rows = row_count;

  perform public.recompute_matchup_scores(p_league, p_season, p_week);
  return v_rows;
end;
$$;

-- Draft clock expiry: any member of that league may trigger it, since
-- whoever has the room open is the one who notices the clock run out.
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
  if not found then return null; end if;

  if auth.uid() is not null
     and not public.is_league_member(v_draft.league_id) then
    raise exception 'That is not your draft';
  end if;

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

  select * into v_draft from public.drafts where id = v_lot.draft_id;

  if auth.uid() is not null
     and not public.is_league_member(v_draft.league_id) then
    raise exception 'That is not your draft';
  end if;

  if v_lot.closes_at is null or v_lot.closes_at > now() then return null; end if;

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

-- Small availability helpers: harmless individually, but there is no
-- reason to answer "is this player rostered" about a league you are not
-- in, so they now return as if the player were unknown.
create or replace function public.player_is_free(p_league uuid, p_player text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (auth.uid() is null or public.is_league_member(p_league))
     and not exists (
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
  select (auth.uid() is null or public.is_league_member(p_league))
     and exists (
       select 1 from public.waiver_holds
       where league_id = p_league and player_id = p_player and clears_at > now()
     );
$$;
