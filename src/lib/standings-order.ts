/**
 * The standings in the order the league seeds them.
 *
 * The order itself is worked out once, in the database, by
 * league_seeding_order (0041) -- wins, losses, then the league's own
 * seeding_tiebreakers -- and reaches the page through the members-only
 * league_standings_order. This only puts the rows in that order, so the
 * standings, their playoff cut line and the bracket generate_playoffs
 * draws can never disagree.
 *
 * Type imports only (erased at runtime), so the tests can load it
 * straight from node.
 */
import type { StandingsRow } from "@/lib/types";

/**
 * `seedByTeam` is team id -> seed from league_standings_order. A team
 * it does not know -- or every team, if the call failed -- falls back
 * to wins, losses, points for and team id, which is the order the page
 * used before seeding became a setting. That keeps the page readable
 * rather than blank; it is never the normal path.
 */
export function orderStandings<T extends Pick<
  StandingsRow,
  "team_id" | "wins" | "losses" | "points_for"
>>(rows: T[], seedByTeam: Map<string, number>): T[] {
  const fallback = (a: T, b: T) =>
    Number(b.wins) - Number(a.wins) ||
    Number(a.losses) - Number(b.losses) ||
    Number(b.points_for) - Number(a.points_for) ||
    (a.team_id < b.team_id ? -1 : a.team_id > b.team_id ? 1 : 0);

  return [...rows].sort((a, b) => {
    const sa = seedByTeam.get(a.team_id);
    const sb = seedByTeam.get(b.team_id);
    if (sa !== undefined && sb !== undefined) return sa - sb;
    if (sa !== undefined) return -1;
    if (sb !== undefined) return 1;
    return fallback(a, b);
  });
}

/**
 * Whether the row at `index` (0-based, in orderStandings order) is above
 * the playoff cut: the first `playoffTeams` rows, which are exactly the
 * teams generate_playoffs seeds.
 */
export function makesPlayoffs(index: number, playoffTeams: number): boolean {
  return index < playoffTeams;
}
