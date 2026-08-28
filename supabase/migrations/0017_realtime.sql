-- =====================================================================
-- 0017  Realtime publication
--
-- Supabase only streams changes for tables in the supabase_realtime
-- publication. These are the tables where a change needs to reach other
-- people's screens without a refresh: the draft board on draft night,
-- the chat, and live matchup scores on Sunday.
--
-- Realtime still respects RLS, so subscribers only receive rows they
-- could have selected anyway.
-- =====================================================================

do $$
declare
  t text;
begin
  -- Supabase creates this publication, but a bare Postgres will not have it.
  if not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    create publication supabase_realtime;
  end if;

  foreach t in array array[
    'league_messages',
    'drafts',
    'draft_picks',
    'auction_lots',
    'auction_bids',
    'matchups',
    'transactions'
  ]
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;

-- Realtime sends only the primary key on UPDATE/DELETE unless the table
-- has replica identity full. The draft board needs the whole row.
alter table public.draft_picks   replica identity full;
alter table public.drafts        replica identity full;
alter table public.auction_lots  replica identity full;
alter table public.matchups      replica identity full;
