import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { FacingRow } from "@/lib/defense-vs-position";

/**
 * The server side of defense-vs-position (T-089): the one read that feeds
 * both the drill-down and the lineup rating.
 *
 * The grain we want -- "a player of position X scored N against team Y in
 * week W, in this league" -- lives across three tables. player_week_scores
 * holds the points in *this* league's scoring (the same source the Players
 * tab, compare and standings read). Which defense a man actually faced
 * that week is player_game_stats.opponent, recorded alongside the stat
 * line the score was computed from -- the cleanest per-week opponent we
 * have, and right even for a player who changed teams mid-season.
 * nfl_players carries the position we scope to.
 *
 * Scoped to one league-season and a handful of positions, so the row count
 * is those positions' worth of players across the weeks played -- small
 * enough for a plain two-query read, no RPC or extra index. The join
 * happens here in JS rather than in Postgres because player_week_scores
 * has no foreign key to a per-week game-stat row to embed through. The
 * game stats are scoped to the regular season (season_type = 'REG'),
 * matching the pool/scoring reads, so a postseason line never pollutes a
 * ranking (and two games in one week never collide on a React key).
 */
export async function fetchFacingRowsByPosition(
  leagueId: string,
  season: number,
  positions: string[],
): Promise<Map<string, FacingRow[]>> {
  // One bucket per requested position, present even when it drew no rows,
  // so the caller can look each starter's position up unconditionally.
  const byPosition = new Map<string, FacingRow[]>(
    positions.map((p) => [p, []] as const),
  );
  if (positions.length === 0) return byPosition;

  const supabase = await createClient();

  // Who faced whom, for every player at these positions this regular
  // season. The inner join filters player_game_stats down to the
  // positions we were asked for.
  const { data: games } = await supabase
    .from("player_game_stats")
    .select(
      "player_id, week, opponent, nfl_players!inner(full_name, position, headshot_url)",
    )
    .eq("season", season)
    .eq("season_type", "REG")
    .in("nfl_players.position", positions);

  const facings = (games ?? []) as unknown as {
    player_id: string;
    week: number;
    opponent: string | null;
    nfl_players: {
      full_name: string;
      position: string | null;
      headshot_url: string | null;
    };
  }[];

  if (facings.length === 0) return byPosition;

  // This league's points for exactly those players. Keyed player|week to
  // line each score up with the week it was scored in.
  const ids = [...new Set(facings.map((f) => f.player_id))];
  const { data: scores } = await supabase
    .from("player_week_scores")
    .select("player_id, week, points")
    .eq("league_id", leagueId)
    .eq("season", season)
    .in("player_id", ids);

  const pointsByKey = new Map(
    ((scores ?? []) as { player_id: string; week: number; points: number }[]).map(
      (s) => [`${s.player_id}|${s.week}`, Number(s.points)] as const,
    ),
  );

  for (const f of facings) {
    if (!f.opponent) continue;
    const position = f.nfl_players.position;
    if (!position) continue;
    const bucket = byPosition.get(position);
    if (!bucket) continue;
    const points = pointsByKey.get(`${f.player_id}|${f.week}`);
    if (points === undefined) continue;
    bucket.push({
      playerId: f.player_id,
      playerName: f.nfl_players.full_name,
      headshotUrl: f.nfl_players.headshot_url,
      opponent: f.opponent,
      week: f.week,
      points,
    });
  }

  return byPosition;
}

/**
 * The single-position read behind the drill-down. A thin wrapper over the
 * consolidated fetch, so both paths share the same regular-season scope and
 * join logic.
 */
export async function fetchFacingRows(
  leagueId: string,
  season: number,
  position: string,
): Promise<FacingRow[]> {
  const byPosition = await fetchFacingRowsByPosition(leagueId, season, [
    position,
  ]);
  return byPosition.get(position) ?? [];
}

/** The NFL team's display name (e.g. "Miami Dolphins"), or the abbr. */
export async function fetchTeamName(abbr: string): Promise<string> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("nfl_teams")
    .select("name")
    .eq("abbr", abbr)
    .maybeSingle();
  return (data?.name as string | undefined) ?? abbr;
}
