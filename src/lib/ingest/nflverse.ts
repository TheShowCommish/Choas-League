/**
 * nflverse-data release URLs.
 *
 * These are public GitHub release assets -- no key, no rate limit worth
 * worrying about. The naming scheme is stable but has changed before
 * (player_stats -> stats_player), so it lives in one place.
 *
 * https://github.com/nflverse/nflverse-data/releases
 */

const BASE = "https://github.com/nflverse/nflverse-data/releases/download";

export const nflverseUrls = {
  /** Every player who has ever appeared, with cross-source ids. */
  players: () => `${BASE}/players/players.csv`,

  /** Every game, all seasons, with scores once they are played. */
  games: () => `${BASE}/schedules/games.csv`,

  /** Weekly per-player box scores. ~150 columns. */
  playerWeek: (season: number) =>
    `${BASE}/stats_player/stats_player_week_${season}.csv`,

  /** Weekly per-team totals, offence and defence. */
  teamWeek: (season: number) =>
    `${BASE}/stats_team/stats_team_week_${season}.csv`,

  /** Offensive/defensive snap counts, keyed by pfr_player_id. */
  snapCounts: (season: number) => `${BASE}/snap_counts/snap_counts_${season}.csv`,

  /** Pro Football Reference advanced charting, keyed by pfr_player_id. */
  advRush: (season: number) =>
    `${BASE}/pfr_advstats/advstats_week_rush_${season}.csv`,
  advRec: (season: number) =>
    `${BASE}/pfr_advstats/advstats_week_rec_${season}.csv`,
  advPass: (season: number) =>
    `${BASE}/pfr_advstats/advstats_week_pass_${season}.csv`,
  advDef: (season: number) =>
    `${BASE}/pfr_advstats/advstats_week_def_${season}.csv`,
};

/**
 * nflverse team abbreviations drift over time (OAK/LV, SD/LAC, STL/LA).
 * Historic rows keep the old code, so normalise to what nfl_teams holds.
 */
const TEAM_ALIASES: Record<string, string> = {
  OAK: "LV",
  SD: "LAC",
  OAK_LV: "LV",
  STL: "LA",
  OAKLV: "LV",
  LAR: "LA",
  WSH: "WAS",
  ARZ: "ARI",
  BLT: "BAL",
  CLV: "CLE",
  HST: "HOU",
  SL: "LA",
};

export function normalizeTeam(abbr: string | null): string | null {
  if (!abbr) return null;
  const upper = abbr.toUpperCase();
  return TEAM_ALIASES[upper] ?? upper;
}

/**
 * The NFL season a given date belongs to. The league year rolls over in
 * March, but for fantasy purposes anything before July is last season.
 */
export function currentSeason(now = new Date()): number {
  return now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}
