-- =====================================================================
-- 0037  Where a player ranks at his own position, stat by stat
--
-- The player page lists a season's stat totals, which answers "how many"
-- and not the question anybody actually has, which is "is that a lot".
-- 1,100 rushing yards means nothing on its own and a great deal once it
-- is the fourth-best figure among running backs.
--
-- Ranking is done here rather than in the app because the comparison set
-- is every player at the position -- a few thousand stat lines and forty
-- keys each. Shipping that to a page to sort it would be absurd.
--
-- Ranked among the players who actually recorded the stat, not among
-- everyone who holds the position: "6th of 38" reads correctly when the
-- 38 are the backs who caught a pass, and reads as noise when they are
-- every back on an NFL roster including the ones who never played.
-- =====================================================================

create or replace function public.player_stat_ranks(
  p_player text,
  p_season int
)
returns table (
  stat_key text,
  total    numeric,
  rank     int,
  pool     int
)
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select position from public.nfl_players where id = p_player
  ),
  -- Everyone he is measured against. `is not distinct from` so a player
  -- whose position we never learned is compared with the others in the
  -- same state rather than with nobody.
  peers as (
    select p.id
    from public.nfl_players p, me
    where p.position is not distinct from me.position
  ),
  totals as (
    select s.player_id,
           kv.key,
           sum((kv.value #>> '{}')::numeric) as total
    from public.player_game_stats s
    join peers on peers.id = s.player_id
    cross join lateral jsonb_each(s.stats) as kv(key, value)
    where s.season = p_season
      and jsonb_typeof(kv.value) = 'number'
    group by s.player_id, kv.key
  ),
  ranked as (
    select t.player_id,
           t.key,
           t.total,
           rank() over (partition by t.key order by t.total desc) as rnk,
           count(*) over (partition by t.key)                     as pool
    from totals t
    -- A column of "47th of 47" for every stat a player never recorded
    -- is not information.
    where t.total <> 0
  )
  select r.key, r.total, r.rnk::int, r.pool::int
  from ranked r
  where r.player_id = p_player;
$$;

grant execute on function public.player_stat_ranks(text, int) to authenticated;
