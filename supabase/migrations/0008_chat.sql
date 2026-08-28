-- =====================================================================
-- 0008  League message board
-- =====================================================================

create table if not exists public.league_messages (
  id         uuid primary key default gen_random_uuid(),
  league_id  uuid not null references public.leagues(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  body       text not null check (length(trim(body)) > 0 and length(body) <= 4000),
  -- set for system-generated posts (trade completed, waivers processed, ...)
  is_system  boolean not null default false,
  created_at timestamptz not null default now(),
  edited_at  timestamptz,
  deleted_at timestamptz
);

create index if not exists league_messages_idx
  on public.league_messages(league_id, created_at desc);
