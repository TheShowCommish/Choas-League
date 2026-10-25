import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AwardMatchup } from "@/lib/weekly-awards";

/**
 * The finalized, single-week matchups the weekly awards are computed from
 * (T-076). Multi-week playoff games are excluded: their stored score is a
 * multi-week total, not one NFL week's, so they are not comparable as a
 * "high score of the week". Shared by Home (latest week) and the awards
 * page (all weeks).
 */
export async function fetchAwardMatchups(
  // The server and browser clients are typed with different generics.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  leagueId: string,
  season: number,
): Promise<AwardMatchup[]> {
  const { data } = await supabase
    .from("matchups")
    .select(
      "week, week_count, home_team_id, home_score, away_team_id, away_score, status",
    )
    .eq("league_id", leagueId)
    .eq("season", season)
    .eq("status", "final")
    .eq("week_count", 1);

  return ((data ?? []) as {
    week: number;
    home_team_id: string;
    home_score: number | string;
    away_team_id: string | null;
    away_score: number | string;
    status: AwardMatchup["status"];
  }[]).map((m) => ({
    week: m.week,
    homeTeamId: m.home_team_id,
    homeScore: Number(m.home_score),
    awayTeamId: m.away_team_id,
    awayScore: Number(m.away_score),
    status: m.status,
  }));
}
