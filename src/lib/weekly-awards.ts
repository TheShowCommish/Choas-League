/**
 * Weekly trophies / awards (T-076): the Sleeper/Yahoo-style "high score of
 * the week", "toilet" (low score), biggest blowout and closest game, read
 * off a week's finalized head-to-head matchups.
 *
 * Everything here is pure, so the Home block, the season-awards page and the
 * unit test all derive the same trophies from the same finalized scores.
 *
 * Data source and scope: awards are computed from finalized, SINGLE-week
 * matchups (`status = "final"`, `week_count = 1`), reading each side's
 * `home_score` / `away_score` as that team's score for the one NFL week and
 * the home/away pairing for the margins. Multi-week playoff matchups are
 * deliberately left out: their stored score is a 2-4 week total, not a single
 * week's, so "high score of the week" would not be comparable.
 *
 * Per-league on/off: v1 is always-on. A stored commissioner toggle would be a
 * new column (a gated migration), so it is left as a follow-up.
 *
 * Ties are broken deterministically by team id (ascending) for the score
 * awards, and by the winning team's id (ascending) for the margin awards, so
 * the same inputs always yield the same trophy.
 */

/** One finalized matchup, reduced to what the awards turn on. */
export interface AwardMatchup {
  /** The NFL week the matchup was played in. */
  week: number;
  homeTeamId: string;
  homeScore: number;
  /** null for a bye: the home team scores, there is no opponent. */
  awayTeamId: string | null;
  awayScore: number;
  status: "scheduled" | "in_progress" | "final";
}

/** A high- or low-score trophy: one team and what it scored. */
export interface TeamScoreAward {
  teamId: string;
  points: number;
}

/** A margin trophy (blowout / closest): both teams and the gap. */
export interface MarginAward {
  winnerTeamId: string;
  winnerScore: number;
  loserTeamId: string;
  loserScore: number;
  /** Always > 0: ties are not a winning margin. */
  margin: number;
}

export interface WeeklyAwards {
  /** Highest single-team score of the week. */
  highScore: TeamScoreAward | null;
  /** Lowest single-team score of the week (the "toilet"). */
  lowScore: TeamScoreAward | null;
  /** Largest winning margin of the week. */
  blowout: MarginAward | null;
  /** Smallest non-zero winning margin of the week (the nail-biter). */
  closest: MarginAward | null;
}

const NO_AWARDS: WeeklyAwards = {
  highScore: null,
  lowScore: null,
  blowout: null,
  closest: null,
};

/** A two-team game (not a bye), reduced to winner, loser and margin. */
function toMargin(m: AwardMatchup): MarginAward | null {
  if (m.awayTeamId === null) return null;
  const margin = Math.abs(m.homeScore - m.awayScore);
  if (margin <= 0) return null; // a tie is not a winning margin
  const homeWon = m.homeScore > m.awayScore;
  return {
    winnerTeamId: homeWon ? m.homeTeamId : m.awayTeamId,
    winnerScore: homeWon ? m.homeScore : m.awayScore,
    loserTeamId: homeWon ? m.awayTeamId : m.homeTeamId,
    loserScore: homeWon ? m.awayScore : m.homeScore,
    margin,
  };
}

/**
 * The four trophies for one week's matchups. Only finalized ones count; a
 * week with nothing final (or no matchups at all) yields all nulls.
 */
export function weeklyAwards(matchups: AwardMatchup[]): WeeklyAwards {
  const final = matchups.filter((m) => m.status === "final");
  if (final.length === 0) return NO_AWARDS;

  // Every team that played, with its score. A bye counts the home team
  // only -- the away side does not exist.
  const scores: TeamScoreAward[] = [];
  for (const m of final) {
    scores.push({ teamId: m.homeTeamId, points: m.homeScore });
    if (m.awayTeamId !== null) {
      scores.push({ teamId: m.awayTeamId, points: m.awayScore });
    }
  }
  if (scores.length === 0) return NO_AWARDS;

  // High / low, tie broken by team id ascending.
  let highScore = scores[0];
  let lowScore = scores[0];
  for (const s of scores) {
    if (
      s.points > highScore.points ||
      (s.points === highScore.points && s.teamId < highScore.teamId)
    ) {
      highScore = s;
    }
    if (
      s.points < lowScore.points ||
      (s.points === lowScore.points && s.teamId < lowScore.teamId)
    ) {
      lowScore = s;
    }
  }

  // Blowout / closest, over two-team games with a winner; tie broken by
  // winning team id ascending.
  const margins = final
    .map(toMargin)
    .filter((x): x is MarginAward => x !== null);

  let blowout: MarginAward | null = null;
  let closest: MarginAward | null = null;
  for (const g of margins) {
    if (
      !blowout ||
      g.margin > blowout.margin ||
      (g.margin === blowout.margin && g.winnerTeamId < blowout.winnerTeamId)
    ) {
      blowout = g;
    }
    if (
      !closest ||
      g.margin < closest.margin ||
      (g.margin === closest.margin && g.winnerTeamId < closest.winnerTeamId)
    ) {
      closest = g;
    }
  }

  return { highScore, lowScore, blowout, closest };
}

/** A week's number paired with its trophies. */
export interface WeekAwards {
  week: number;
  awards: WeeklyAwards;
}

/**
 * Group finalized matchups by NFL week and compute each week's trophies,
 * newest week first. Weeks that produced no trophy at all (nothing final)
 * are dropped, so the season list only shows weeks with awards.
 */
export function awardsByWeek(matchups: AwardMatchup[]): WeekAwards[] {
  const byWeek = new Map<number, AwardMatchup[]>();
  for (const m of matchups) {
    const list = byWeek.get(m.week) ?? [];
    list.push(m);
    byWeek.set(m.week, list);
  }

  const out: WeekAwards[] = [];
  for (const [week, list] of byWeek) {
    const awards = weeklyAwards(list);
    if (awards.highScore) out.push({ week, awards });
  }
  return out.sort((a, b) => b.week - a.week);
}
