-- =====================================================================
-- 0018  Cross-source player ids
--
-- The advanced stat feeds (Pro Football Reference charting, snap counts)
-- are keyed by pfr_player_id, not by the gsis_id everything else uses,
-- so we need to store the mapping to merge them in.
-- =====================================================================

alter table public.nfl_players
  add column if not exists pfr_id text,
  add column if not exists position_group text,
  add column if not exists last_season int;

create index if not exists nfl_players_pfr_idx on public.nfl_players(pfr_id)
  where pfr_id is not null;

-- Ingestion looks players up by pfr_id often enough to want it unique;
-- a handful of historic rows share a blank id, hence the partial index.
create unique index if not exists nfl_players_pfr_unique
  on public.nfl_players(pfr_id) where pfr_id is not null;
