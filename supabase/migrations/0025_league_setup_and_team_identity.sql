-- =====================================================================
-- 0025  Fixed-size leagues, claimable teams, team identity
--
-- Until now a league grew a team every time somebody joined, which made
-- the size of the league an emergent property of who happened to turn
-- up. A commissioner setting up in July wants the opposite: twelve
-- teams on the board from the start, named Team 1..Team 12, and
-- managers claiming one as they arrive.
--
-- So: leagues carry a team_count, the teams are created with the
-- league, and joining claims an empty one rather than making a new one.
-- =====================================================================

alter table public.leagues
  add column if not exists team_count int not null default 10
    check (team_count between 2 and 32);

alter table public.teams
  -- Hex, '#RRGGBB'. Used for the team's accent throughout the UI.
  add column if not exists color text not null default '#6366f1'
    check (color ~ '^#[0-9a-fA-F]{6}$'),
  -- Which of the generic slots this was, so "Team 7" keeps its place in
  -- listings after it is renamed to something unpronounceable.
  add column if not exists slot_number int;

-- Create the league's teams up front -----------------------------------
create or replace function public.seed_league_teams()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_i int;
begin
  for v_i in 1..new.team_count loop
    insert into public.teams
      (league_id, owner_id, name, abbreviation, waiver_priority, slot_number)
    values
      (new.id, null, 'Team ' || v_i, 'T' || v_i, v_i, v_i)
    on conflict (league_id, name) do nothing;
  end loop;
  return new;
end;
$$;

-- Sorts after leagues_seed_scoring, before leagues_zz_seed_scores.
drop trigger if exists leagues_seed_teams on public.leagues;
create trigger leagues_seed_teams after insert on public.leagues
  for each row execute function public.seed_league_teams();

-- Claim an unclaimed team ----------------------------------------------
create or replace function public.claim_team(
  p_team uuid, p_team_name text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league uuid;
  v_owner  uuid;
  v_mine   uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  select league_id, owner_id into v_league, v_owner
    from public.teams where id = p_team;

  if v_league is null then
    raise exception 'No such team';
  end if;
  if not public.is_league_member(v_league) then
    raise exception 'You are not in that league';
  end if;
  if v_owner is not null then
    raise exception 'Somebody has already taken that team';
  end if;

  select id into v_mine from public.teams
    where league_id = v_league and owner_id = auth.uid();
  if v_mine is not null then
    raise exception 'You already manage a team in this league';
  end if;

  perform public.begin_internal_write();

  update public.teams
    set owner_id = auth.uid(),
        name     = coalesce(nullif(trim(p_team_name), ''), name)
    where id = p_team;

  return p_team;
end;
$$;

-- Joining now claims a team instead of creating one --------------------
--
-- The league's size is fixed at creation, so a join that would be the
-- thirteenth manager in a twelve-team league is refused rather than
-- quietly widening the league.
create or replace function public.join_league(p_join_code text, p_team_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league  public.leagues%rowtype;
  v_team_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  select * into v_league from public.leagues
  where upper(join_code) = upper(trim(p_join_code));

  if not found then
    raise exception 'No league with that join code';
  end if;

  insert into public.league_members (league_id, user_id, role)
  values (v_league.id, auth.uid(), 'member')
  on conflict (league_id, user_id) do nothing;

  -- Already have a team here? Then this is a repeat join; hand it back.
  select id into v_team_id from public.teams
  where league_id = v_league.id and owner_id = auth.uid();

  if v_team_id is null then
    -- Lowest-numbered free team, so the board fills in order.
    select id into v_team_id from public.teams
    where league_id = v_league.id and owner_id is null
    order by slot_number nulls last, name
    limit 1
    for update skip locked;

    if v_team_id is null then
      raise exception 'This league is full';
    end if;

    perform public.begin_internal_write();

    update public.teams
      set owner_id = auth.uid(),
          name     = coalesce(nullif(trim(p_team_name), ''), name)
      where id = v_team_id;
  end if;

  update public.league_invites
    set accepted_at = now()
    where league_id = v_league.id
      and lower(email) = lower(coalesce(auth.jwt()->>'email', ''));

  return v_team_id;
end;
$$;

-- Join without taking a team -------------------------------------------
--
-- The two-step flow: follow the invite link to become a member, then
-- pick a team off the board. join_league above is the one-step version,
-- for anyone who does not care which slot they get.
create or replace function public.join_league_as_member(p_join_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league public.leagues%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  select * into v_league from public.leagues
  where upper(join_code) = upper(trim(p_join_code));

  if not found then
    raise exception 'No league with that join code';
  end if;

  insert into public.league_members (league_id, user_id, role)
  values (v_league.id, auth.uid(), 'member')
  on conflict (league_id, user_id) do nothing;

  update public.league_invites
    set accepted_at = now()
    where league_id = v_league.id
      and lower(email) = lower(coalesce(auth.jwt()->>'email', ''));

  return v_league.id;
end;
$$;

-- Changing the league size after the fact ------------------------------
-- Growing adds empty teams. Shrinking only ever removes empty ones, and
-- refuses rather than deleting somebody's roster.
create or replace function public.set_team_count(p_league uuid, p_count int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current int;
  v_owned   int;
  v_i       int;
  v_victim  uuid;
begin
  if not public.is_commissioner(p_league) then
    raise exception 'Only the commissioner can resize the league';
  end if;
  if p_count < 2 or p_count > 32 then
    raise exception 'A league has between 2 and 32 teams';
  end if;

  select count(*) into v_current from public.teams where league_id = p_league;
  select count(*) into v_owned   from public.teams
    where league_id = p_league and owner_id is not null;

  if p_count < v_owned then
    raise exception
      'There are already % teams with managers', v_owned;
  end if;

  if p_count > v_current then
    for v_i in (v_current + 1)..p_count loop
      insert into public.teams
        (league_id, owner_id, name, abbreviation, waiver_priority, slot_number)
      values
        (p_league, null, 'Team ' || v_i, 'T' || v_i, v_i, v_i)
      on conflict (league_id, name) do nothing;
    end loop;
  elsif p_count < v_current then
    for v_victim in
      select id from public.teams
      where league_id = p_league and owner_id is null
      order by slot_number desc nulls first, name desc
      limit (v_current - p_count)
    loop
      delete from public.teams where id = v_victim;
    end loop;
  end if;

  update public.leagues set team_count = p_count where id = p_league;

  return p_count;
end;
$$;

-- Teams now exist before the commissioner has finished setting up, so a
-- later change to the FAAB budget has to reach them. Only teams still
-- sitting on the old budget are moved: anyone who has already spent is
-- left alone.
create or replace function public.sync_team_faab()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.faab_budget is distinct from old.faab_budget then
    perform public.begin_internal_write();
    update public.teams
      set faab_remaining = new.faab_budget
      where league_id = new.id
        and faab_remaining = old.faab_budget;
  end if;
  return new;
end;
$$;

drop trigger if exists leagues_sync_faab on public.leagues;
create trigger leagues_sync_faab after update of faab_budget on public.leagues
  for each row execute function public.sync_team_faab();

grant execute on function public.claim_team(uuid, text)      to authenticated;
grant execute on function public.join_league_as_member(text) to authenticated;
grant execute on function public.set_team_count(uuid, int)   to authenticated;

-- Existing leagues: backfill slot numbers and the recorded size --------
update public.teams t
  set slot_number = sub.rn
  from (
    select id, row_number() over (partition by league_id order by waiver_priority, name) as rn
    from public.teams
  ) sub
  where t.id = sub.id and t.slot_number is null;

update public.leagues l
  set team_count = greatest(
    l.team_count,
    (select count(*) from public.teams where league_id = l.id)
  );

-- Team logo storage ----------------------------------------------------
-- Guarded: the scratch Postgres used by `npm run db:verify` has no
-- storage schema, and this migration still needs to parse there.
do $do$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'team-logos', 'team-logos', true, 2097152,
      array['image/png','image/jpeg','image/webp','image/gif','image/svg+xml']
    )
    on conflict (id) do update
      set public = true,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;

    -- Anyone signed in may read; a manager may write only under the
    -- folder named for a team they own. One EXECUTE per statement:
    -- `storage` does not exist on the scratch Postgres, so nothing in
    -- here is covered by `npm run db:verify`.
    execute 'drop policy if exists team_logos_read on storage.objects';
    execute $p$
      create policy team_logos_read on storage.objects
        for select to authenticated using (bucket_id = 'team-logos')
    $p$;

    execute 'drop policy if exists team_logos_write on storage.objects';
    execute $p$
      create policy team_logos_write on storage.objects
        for insert to authenticated with check (
          bucket_id = 'team-logos'
          and public.owns_team((split_part(name, '/', 1))::uuid)
        )
    $p$;

    execute 'drop policy if exists team_logos_update on storage.objects';
    execute $p$
      create policy team_logos_update on storage.objects
        for update to authenticated using (
          bucket_id = 'team-logos'
          and public.owns_team((split_part(name, '/', 1))::uuid)
        )
    $p$;

    execute 'drop policy if exists team_logos_delete on storage.objects';
    execute $p$
      create policy team_logos_delete on storage.objects
        for delete to authenticated using (
          bucket_id = 'team-logos'
          and public.owns_team((split_part(name, '/', 1))::uuid)
        )
    $p$;
  end if;
end
$do$;
