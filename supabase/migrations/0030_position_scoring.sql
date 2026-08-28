-- =====================================================================
-- 0030  Scoring the same stat differently by position
--
-- league_scoring_rules already had a `positions` array, but
-- `unique (league_id, stat_key)` allowed only one rule per stat, so the
-- column could restrict a rule and never vary it. A league that wants a
-- quarterback's tackle to be worth 50 and a receiver's worth 5 needs two
-- rules for `tackles_combined`, and could not have them.
--
-- Now: many rules per stat. An empty `positions` is the base rule for
-- everyone; a rule naming positions overrides it for those positions
-- only. The engine picks exactly one rule per stat per player -- the
-- most specific that matches -- rather than summing every match, which
-- is what the old join would have done given the chance.
-- =====================================================================

alter table public.league_scoring_rules
  drop constraint if exists league_scoring_rules_league_id_stat_key_key;

-- One rule per stat per position set. The UI only ever writes an empty
-- array or a single-position array, so the ordering of the array is not
-- a source of near-duplicates.
create unique index if not exists lsr_league_stat_positions
  on public.league_scoring_rules(league_id, stat_key, positions);

-- Anything that upserted on (league_id, stat_key) has to name the new
-- index instead, or ON CONFLICT no longer matches a constraint.
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
  on conflict (league_id, stat_key, positions) do nothing;
  return new;
end;
$$;

/**
 * The rule that applies to one stat for one player.
 *
 * Most specific wins: a rule naming the player's position beats the
 * catch-all. Ties (two rules both naming his position) cannot happen,
 * because the unique index above forbids them.
 */
create or replace function public.scoring_rule_points(
  p_league uuid, p_stat text, p_position text
) returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select r.points
  from public.league_scoring_rules r
  where r.league_id = p_league
    and r.stat_key = p_stat
    and (
      cardinality(r.positions) = 0
      or (p_position is not null and p_position = any(r.positions))
    )
  order by cardinality(r.positions) desc
  limit 1;
$$;

grant execute on function public.scoring_rule_points(uuid, text, text)
  to authenticated;

-- Rescore using the most specific rule ---------------------------------
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
      bool_and(pgs.source = 'final')          as is_final,
      sum(public.safe_numeric(kv.value) * r.points) as points,
      jsonb_object_agg(
        kv.key,
        jsonb_build_object(
          'value',  public.safe_numeric(kv.value),
          'points', round(public.safe_numeric(kv.value) * r.points, 2)
        )
      )                                       as breakdown
    from public.player_game_stats pgs
    join public.nfl_players pl on pl.id = pgs.player_id
    cross join lateral jsonb_each_text(pgs.stats) as kv(key, value)
    -- Exactly one rule per stat: the most specific that matches. A plain
    -- join would multiply a stat by every rule that applied to it.
    join lateral (
      select r.points
      from public.league_scoring_rules r
      where r.league_id = p_league
        and r.stat_key  = kv.key
        and r.points   <> 0
        and (
          cardinality(r.positions) = 0
          or (pl.position is not null and pl.position = any(r.positions))
        )
      order by cardinality(r.positions) desc
      limit 1
    ) r on true
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

-- Projections score the same way ---------------------------------------
create or replace function public.projected_points(
  p_league uuid, p_player text, p_season int, p_week int
) returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select round(coalesce(sum(
           public.safe_numeric(kv.value)
           * public.scoring_rule_points(p_league, kv.key, pl.position)
         ), 0), 2)
  from public.player_week_projections pwp
  join public.nfl_players pl on pl.id = pwp.player_id
  cross join lateral jsonb_each_text(pwp.stats) as kv(key, value)
  where pwp.player_id = p_player
    and pwp.season    = p_season
    and pwp.week      = p_week
    and public.is_league_member(p_league);
$$;

create or replace function public.team_projections(
  p_league uuid, p_team uuid, p_season int, p_week int
) returns table (player_id text, points numeric)
language sql
stable
security definer
set search_path = public
as $$
  select rp.player_id,
         round(coalesce(sum(
           public.safe_numeric(kv.value)
           * public.scoring_rule_points(p_league, kv.key, pl.position)
         ), 0), 2)
  from public.roster_players rp
  join public.nfl_players pl on pl.id = rp.player_id
  left join public.player_week_projections pwp
    on pwp.player_id = rp.player_id
   and pwp.season    = p_season
   and pwp.week      = p_week
  left join lateral jsonb_each_text(coalesce(pwp.stats, '{}'::jsonb))
    as kv(key, value) on true
  where rp.team_id = p_team
    and rp.dropped_at is null
    and public.is_league_member(p_league)
  group by rp.player_id;
$$;

grant execute on function public.projected_points(uuid, text, int, int)
  to authenticated;
grant execute on function public.team_projections(uuid, uuid, int, int)
  to authenticated;
