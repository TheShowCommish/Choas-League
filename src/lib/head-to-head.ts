/**
 * Head-to-head history (T-082): the all-time series record between two
 * teams, read off their finalized matchups. The matchup detail page shows
 * it near the scoreboard ("Series: Ravens lead 2-1") the way ESPN/Sleeper do.
 *
 * Everything here is pure, so the page and the unit test tally the same
 * record from the same finalized meetings.
 *
 * Scope: the caller passes the finalized meetings it wants counted. Today
 * that is a SINGLE season's matchups (BOARD T-052 flagged H2H lacking a
 * season filter, so the page scopes its query to league.season); the tally
 * itself is season-agnostic, so a future multi-season view only has to widen
 * that query and pass more meetings in.
 *
 * Each finalized matchup counts as ONE result from its stored total score,
 * the same score the matchup's own winner is read from, so a multi-week
 * playoff round is one series result, not several. A drawn game counts as a
 * tie. Both home/away orientations of the pairing are counted.
 */

/** One meeting between the two teams, reduced to what the tally turns on. */
export interface HeadToHeadMatchup {
  homeTeamId: string;
  /** null for a bye; a bye is not a head-to-head meeting. */
  awayTeamId: string | null;
  homeScore: number;
  awayScore: number;
  status: "scheduled" | "in_progress" | "final";
}

/** The series record, from team A's perspective. */
export interface HeadToHeadRecord {
  teamAWins: number;
  teamBWins: number;
  ties: number;
}

export interface HeadToHeadSummary extends HeadToHeadRecord {
  /** Finalized meetings counted (wins + wins + ties). */
  meetings: number;
  /**
   * Who leads the series, from team A's side: "a" or "b" leads on wins,
   * "tied" when wins are level with at least one meeting, "none" when the
   * two have no finalized meeting yet (the first-meeting case).
   */
  leader: "a" | "b" | "tied" | "none";
}

/**
 * The series record between `teamAId` and `teamBId` over `matchups`. Only
 * finalized meetings between exactly these two teams count, in either
 * home/away orientation; anything else (a bye, a third team, an unfinished
 * game) is ignored. Deterministic.
 */
export function headToHead(
  teamAId: string,
  teamBId: string,
  matchups: HeadToHeadMatchup[],
): HeadToHeadSummary {
  let teamAWins = 0;
  let teamBWins = 0;
  let ties = 0;

  for (const m of matchups) {
    if (m.status !== "final" || m.awayTeamId === null) continue;

    const aIsHome = m.homeTeamId === teamAId && m.awayTeamId === teamBId;
    const aIsAway = m.awayTeamId === teamAId && m.homeTeamId === teamBId;
    if (!aIsHome && !aIsAway) continue;

    const aScore = aIsHome ? m.homeScore : m.awayScore;
    const bScore = aIsHome ? m.awayScore : m.homeScore;

    if (aScore > bScore) teamAWins++;
    else if (bScore > aScore) teamBWins++;
    else ties++;
  }

  const meetings = teamAWins + teamBWins + ties;
  const leader =
    meetings === 0
      ? "none"
      : teamAWins > teamBWins
        ? "a"
        : teamBWins > teamAWins
          ? "b"
          : "tied";

  return { teamAWins, teamBWins, ties, meetings, leader };
}
