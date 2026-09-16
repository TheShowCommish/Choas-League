-- =====================================================================
-- 0035  Writing ADP without pretending it is an insert
--
-- The ADP job wrote its numbers with a partial upsert: id plus the four
-- adp_* columns, keyed on id, on the reasoning that every id came from
-- nfl_players in the first place and so would always conflict.
--
-- It never got that far. Postgres builds and validates the proposed row
-- *before* it looks for a conflict, so a payload that omits full_name
-- fails its NOT NULL constraint whether or not the row already exists:
--
--   null value in column "full_name" of relation "nfl_players"
--   violates not-null constraint
--
-- A partial upsert is therefore not a thing this table can support. The
-- operation was always an UPDATE, so this is one.
--
-- Clearing and setting happen together, in one statement each and one
-- transaction, so there is no window in which the whole league's draft
-- board has no order at all.
-- =====================================================================

/**
 * Replaces the stored ADP with `p_rows`.
 *
 * `p_rows` is a JSON array of {id, adp, adp_rank, adp_source}. Anything
 * previously sourced from ESPN and not named again is cleared, because
 * a player who has dropped off the board keeping a stale ADP is worse
 * than having none -- he would still sort near the top.
 *
 * Returns how many players were given a number.
 *
 * Reference data, so only the ingestion jobs may call it. They reach
 * Postgres as `service_role`; a browser reaches it as `anon` or
 * `authenticated`, and neither has any business here. A direct psql or
 * test connection sets no JWT claims at all, which is why a missing
 * role is treated as trusted rather than rejected.
 */
create or replace function public.set_player_adp(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_set  int;
begin
  v_role := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role',
    'service_role'
  );

  if v_role <> 'service_role' then
    raise exception 'Only the ingestion jobs can set ADP';
  end if;

  update public.nfl_players
     set adp = null, adp_rank = null
   where adp_source in ('espn', 'espn-rank')
     and adp is not null;

  update public.nfl_players p
     set adp            = (r.value->>'adp')::numeric,
         adp_rank       = (r.value->>'adp_rank')::int,
         adp_source     = r.value->>'adp_source',
         adp_updated_at = now()
    from jsonb_array_elements(p_rows) as r
   where p.id = r.value->>'id';

  get diagnostics v_set = row_count;
  return v_set;
end;
$$;
