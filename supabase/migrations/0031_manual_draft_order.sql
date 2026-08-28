-- =====================================================================
-- 0031  Setting the draft order by hand
--
-- generate_draft could randomise the order or leave whatever was there,
-- with no way to say what it should be. Commissioners want to set it
-- deliberately -- reverse standings, a lottery run elsewhere, or the
-- result of an argument at the pub.
-- =====================================================================

create or replace function public.set_draft_order(
  p_league uuid, p_team_ids uuid[]
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_draft   public.drafts%rowtype;
  v_slot    int;
  v_league  uuid;
  v_count   int;
begin
  if not public.is_commissioner(p_league) then
    raise exception 'Only the commissioner can set the draft order';
  end if;

  select * into v_draft from public.drafts where league_id = p_league;
  if not found then
    insert into public.drafts (league_id) values (p_league)
      returning * into v_draft;
  end if;

  if v_draft.status = 'live' then
    raise exception 'The draft is under way; pause it before reordering';
  end if;

  -- Every id has to be a team in this league, and each may appear once.
  if array_length(p_team_ids, 1) is null then
    raise exception 'An order needs at least one team';
  end if;

  select count(distinct t) into v_count
    from unnest(p_team_ids) as t;
  if v_count <> array_length(p_team_ids, 1) then
    raise exception 'A team cannot appear twice in the order';
  end if;

  for v_slot in 1..array_length(p_team_ids, 1) loop
    select league_id into v_league
      from public.teams where id = p_team_ids[v_slot];
    if v_league is distinct from p_league then
      raise exception 'That team is not in this league';
    end if;
  end loop;

  select count(*) into v_count from public.teams where league_id = p_league;
  if array_length(p_team_ids, 1) <> v_count then
    raise exception
      'The order lists % teams but the league has %',
      array_length(p_team_ids, 1), v_count;
  end if;

  delete from public.draft_order where draft_id = v_draft.id;
  for v_slot in 1..array_length(p_team_ids, 1) loop
    insert into public.draft_order (draft_id, team_id, position)
    values (v_draft.id, p_team_ids[v_slot], v_slot);
  end loop;

  -- The board is built from the order, so it is now stale.
  delete from public.draft_picks where draft_id = v_draft.id;

  return array_length(p_team_ids, 1);
end;
$$;

grant execute on function public.set_draft_order(uuid, uuid[]) to authenticated;

-- The current order, for the admin UI to render and reorder ------------
-- `position` is reserved in a RETURNS TABLE column list, hence `slot`,
-- the same dodge league_player_pool makes for `pos`.
create or replace function public.draft_order_for(p_league uuid)
returns table (team_id uuid, team_name text, slot int)
language sql
stable
security definer
set search_path = public
as $$
  select d_o.team_id, t.name, d_o.position
  from public.drafts d
  join public.draft_order d_o on d_o.draft_id = d.id
  join public.teams t on t.id = d_o.team_id
  where d.league_id = p_league
    and public.is_league_member(p_league)
  order by d_o.position;
$$;

grant execute on function public.draft_order_for(uuid) to authenticated;
