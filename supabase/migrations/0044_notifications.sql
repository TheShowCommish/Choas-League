-- =====================================================================
-- 0044  In-app notification centre (T-072)
--
-- A per-user, per-league inbox: a trade offer arrives, a waiver clears,
-- a matchup goes final. In-app only -- no email, no push (that needs a
-- paid service, which is a separate call).
--
-- Reading is the user's own: the recipient sees and marks read only
-- their own rows, and only in a league they still belong to. Writing is
-- not open to clients at all -- a manager must not be able to drop a
-- notification into a rival's inbox. Rows go in through notify(), a
-- SECURITY DEFINER function reachable only by the server/jobs under the
-- service role (same shape as finalize_completed_weeks in 0038): the
-- grant is revoked from public, anon and authenticated, which Postgres
-- otherwise leaves in place (see the note in 0042).
-- =====================================================================

create table if not exists public.notifications (
  id                uuid primary key default gen_random_uuid(),
  league_id         uuid not null references public.leagues(id) on delete cascade,
  -- The auth user who should see it. Profiles.id is auth.users.id.
  recipient_user_id uuid not null references public.profiles(id) on delete cascade,
  -- 'trade_offer', 'trade_accepted', 'trade_rejected', 'trade_withdrawn',
  -- 'waiver_won', 'waiver_lost', 'matchup_final' -- kept as free text so a
  -- new kind of alert does not need a migration.
  type              text not null,
  title             text not null,
  body              text not null default '',
  -- Relative path to the screen the alert is about, e.g. /l/<id>/trades.
  link              text not null default '',
  -- Anything the UI might want to key off later (ids, scores); optional.
  data              jsonb,
  read_at           timestamptz,
  created_at        timestamptz not null default now()
);

-- The inbox query: a user's rows in a league, newest first.
create index if not exists notifications_recipient_idx
  on public.notifications (recipient_user_id, league_id, created_at desc);

-- The unread badge: only the rows still unread, so the count stays cheap
-- as read history piles up.
create index if not exists notifications_unread_idx
  on public.notifications (recipient_user_id, league_id)
  where read_at is null;

alter table public.notifications enable row level security;

-- Read: your own rows, in a league you still belong to. A non-member
-- (or someone else) matches nothing.
drop policy if exists notifications_read on public.notifications;
create policy notifications_read on public.notifications
  for select to authenticated
  using (
    recipient_user_id = auth.uid()
    and public.is_league_member(league_id)
  );

-- Update: the same rows, so a user can mark their own alerts read. There
-- is no insert or delete policy -- inserts go through notify() below, and
-- nothing deletes notifications from a client.
drop policy if exists notifications_mark_read on public.notifications;
create policy notifications_mark_read on public.notifications
  for update to authenticated
  using (
    recipient_user_id = auth.uid()
    and public.is_league_member(league_id)
  )
  with check (
    recipient_user_id = auth.uid()
    and public.is_league_member(league_id)
  );

/**
 * Raise one notification. Called by server actions (under the service
 * role) and the scheduled jobs, never straight from a browser.
 *
 * The recipient must be a current member of the league; anything else is
 * a silent no-op, so a stale id never lands a row in an outsider's inbox.
 * Returns the new row's id, or null when nothing was written.
 */
create or replace function public.notify(
  p_league    uuid,
  p_recipient uuid,
  p_type      text,
  p_title     text,
  p_body      text default '',
  p_link      text default '',
  p_data      jsonb default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not exists (
    select 1 from public.league_members
    where league_id = p_league and user_id = p_recipient
  ) then
    return null;
  end if;

  insert into public.notifications
    (league_id, recipient_user_id, type, title, body, link, data)
  values
    (p_league, p_recipient, p_type, p_title,
     coalesce(p_body, ''), coalesce(p_link, ''), p_data)
  returning id into v_id;

  return v_id;
end;
$$;

-- Server-only: the service role reaches it (granted separately by
-- Supabase, as with the other job functions); no signed-in user can.
revoke execute on function
  public.notify(uuid, uuid, text, text, text, text, jsonb)
  from public, anon, authenticated;
