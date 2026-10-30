/**
 * Defense-vs-position, as pure functions (T-089).
 *
 * "Points allowed" is the fantasy mirror of a real defense's numbers: for
 * one NFL team and one position, how much every player of that position
 * scored against it, in this league's own scoring. A zero week is dropped
 * -- a quarterback who did not play, or a defense that shut a man out, is
 * not a data point about the matchup, and ESPN leaves them off too.
 *
 * No I/O here: the server module joins player_week_scores (league points)
 * to player_game_stats (the opponent a man actually faced that week) and
 * hands the flattened rows in, so these are unit-tested directly
 * (scripts/defense-vs-position.test.ts). Relative import for the same
 * reason the other pure helpers use one -- the tests run straight through
 * node, which resolves neither the "@/" alias nor a missing extension.
 */

/**
 * One scored player-week against a given NFL defense: a player of some
 * position, the team he faced, the week, and what he scored in this
 * league. The raw grain everything below is built from.
 */
export interface FacingRow {
  playerId: string;
  playerName: string;
  headshotUrl: string | null;
  /** The NFL team whose defense he faced that week. */
  opponent: string;
  week: number;
  points: number;
}

/** One line of the points-allowed drill-down: a player, a week, a score. */
export interface PointsAllowedRow {
  playerId: string;
  playerName: string;
  headshotUrl: string | null;
  week: number;
  points: number;
}

/** How one NFL defense fares against a position, and where it ranks. */
export interface DefenseRank {
  /** The NFL team whose defense this is. */
  team: string;
  /** Fantasy points it has allowed the position all season (zeros aside). */
  total: number;
  /** Per-game average over the weeks it allowed a score. */
  avg: number;
  /** How many scoring games make up the total. */
  games: number;
  /** 1 = allows the most to this position (the softest matchup). */
  rank: number;
  /** Teams ranked -- the denominator, "Nth of this many". */
  teams: number;
}

/** A week only counts as "allowed" when the man actually scored. */
function scored(row: FacingRow): boolean {
  return row.points > 0;
}

/**
 * Every player of the position who scored against `team`, newest week
 * first (and the bigger score first within a week). Zeros are dropped --
 * the caller has already scoped the rows to one position and season.
 */
export function pointsAllowed(
  rows: FacingRow[],
  team: string,
): PointsAllowedRow[] {
  return rows
    .filter((row) => row.opponent === team && scored(row))
    .map((row) => ({
      playerId: row.playerId,
      playerName: row.playerName,
      headshotUrl: row.headshotUrl,
      week: row.week,
      points: row.points,
    }))
    .sort((a, b) => b.week - a.week || b.points - a.points);
}

/**
 * Ranks every defense in the rows by how much it has allowed the
 * position, most first, so rank 1 is the softest matchup. Ties break by
 * average, then games, then team, so the ranking is total and stable --
 * no two teams share a rank.
 */
export function rankDefenses(rows: FacingRow[]): DefenseRank[] {
  const byTeam = new Map<string, { total: number; games: number }>();

  for (const row of rows) {
    if (!scored(row)) continue;
    const agg = byTeam.get(row.opponent) ?? { total: 0, games: 0 };
    agg.total += row.points;
    agg.games += 1;
    byTeam.set(row.opponent, agg);
  }

  const teams = byTeam.size;

  return [...byTeam.entries()]
    .map(([team, { total, games }]) => ({
      team,
      total: round2(total),
      avg: games ? round2(total / games) : 0,
      games,
    }))
    .sort(
      (a, b) =>
        b.total - a.total ||
        b.avg - a.avg ||
        b.games - a.games ||
        a.team.localeCompare(b.team),
    )
    .map((entry, index) => ({ ...entry, rank: index + 1, teams }));
}

/** The one team's rank, or null when it has faced nobody at the position. */
export function defenseRank(
  rows: FacingRow[],
  team: string,
): DefenseRank | null {
  return rankDefenses(rows).find((entry) => entry.team === team) ?? null;
}

/** 1st, 2nd, 3rd, 4th -- including the 11th-to-13th exceptions. */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** Points carry two decimals everywhere the app shows a fantasy score. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
