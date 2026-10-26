/**
 * Power rankings (T-078): a weekly computed opinion that looks past the raw
 * W-L record, the way ESPN's Power Index and Yahoo's power rankings do. Good
 * trash-talk fuel, and never the official standings.
 *
 * Everything here is pure, so the Standings page and the unit test derive the
 * same ranking from the same aggregates and per-week scores.
 *
 * Data source and scope: the caller passes each team's season aggregates
 * (points-for, games played) plus a flat list of per-week team scores read off
 * finalized, SINGLE-week head-to-head matchups (`status = "final"`,
 * `week_count = 1`) -- the same scores the weekly awards and standings are
 * built from. Multi-week playoff matchups are left out of the per-week list:
 * their stored score is a 2-4 week total, not comparable week to week.
 *
 * The score blends three normalized components, so it rewards a team that
 * scores a lot (season PF), is hot right now (recent form) and would beat most
 * of the field on any given week (all-play win%) -- not just one that won
 * close games. Deterministic throughout; ties break by season PF then team id.
 */

/**
 * How many of a team's most recent finalized weeks feed "recent form". Three
 * is the usual ESPN/Yahoo window: long enough to smooth one fluke week, short
 * enough to still mean "hot or cold lately".
 */
export const RECENT_WEEKS = 3;

/**
 * Component weights, summing to 1. Season PF carries the most weight because a
 * full season of scoring is the steadiest signal of strength; all-play win%
 * is next because it measures a team against the whole field, not just the
 * one opponent luck handed it; recent form is the lightest, a nudge for who
 * is hot right now without letting three weeks outweigh the season.
 */
export const WEIGHT_SEASON_PF = 0.4;
export const WEIGHT_ALL_PLAY = 0.35;
export const WEIGHT_RECENT_FORM = 0.25;

/** One team's season aggregates, as read off the `standings` row. */
export interface PowerTeamInput {
  teamId: string;
  /** Season points-for. */
  pointsFor: number;
  /** Finalized games the team has played; 0 for a team yet to play. */
  gamesPlayed: number;
}

/** One finalized single-week score for one team. */
export interface TeamWeekScore {
  teamId: string;
  week: number;
  points: number;
}

/** A team's place in the power ranking, with the parts that produced it. */
export interface PowerRankingEntry {
  teamId: string;
  /** 1-based, contiguous (1..N), best team first. */
  rank: number;
  /** Blended power score, 0-100, rounded to one decimal. */
  powerScore: number;
  /** Season points-for (passed through, for display and tiebreak). */
  seasonPf: number;
  /** Average of the team's last RECENT_WEEKS finalized scores; 0 if none. */
  recentForm: number;
  /** All-play win fraction over every finalized week, 0-1; 0 if no weeks. */
  allPlayWinPct: number;
}

/** Round to one decimal place (half up), keeping -0 as 0. */
function round1(n: number): number {
  return Math.round(n * 10) / 10 || 0;
}

/**
 * Average of a team's most recent RECENT_WEEKS finalized scores. Weeks are
 * taken newest-first, so a short season simply averages what exists; a team
 * with no finalized week scores 0.
 */
function recentFormFor(scores: TeamWeekScore[]): number {
  if (scores.length === 0) return 0;
  const recent = [...scores]
    .sort((a, b) => b.week - a.week)
    .slice(0, RECENT_WEEKS);
  const total = recent.reduce((sum, s) => sum + s.points, 0);
  return total / recent.length;
}

/**
 * All-play win fraction: across every finalized week, how a team would fare if
 * it had played every other team that week. A win over another score counts 1,
 * a tie counts 0.5, summed over all weeks and divided by the all-play games
 * faced. A week with only one team's score offers no opponent and is skipped.
 */
function allPlayWinPcts(weekScores: TeamWeekScore[]): Map<string, number> {
  const byWeek = new Map<number, TeamWeekScore[]>();
  for (const s of weekScores) {
    const list = byWeek.get(s.week) ?? [];
    list.push(s);
    byWeek.set(s.week, list);
  }

  const wins = new Map<string, number>();
  const games = new Map<string, number>();
  for (const list of byWeek.values()) {
    if (list.length < 2) continue;
    for (const a of list) {
      let w = 0;
      for (const b of list) {
        if (a === b) continue;
        if (a.points > b.points) w += 1;
        else if (a.points === b.points) w += 0.5;
      }
      wins.set(a.teamId, (wins.get(a.teamId) ?? 0) + w);
      games.set(a.teamId, (games.get(a.teamId) ?? 0) + (list.length - 1));
    }
  }

  const pct = new Map<string, number>();
  for (const [teamId, g] of games) {
    pct.set(teamId, g > 0 ? (wins.get(teamId) ?? 0) / g : 0);
  }
  return pct;
}

/**
 * The power ranking for a league's teams. Returns one entry per input team,
 * best first, ranks 1..N contiguous. Deterministic: the blended score orders
 * the field, and ties break by season PF (desc) then team id (asc).
 *
 * Each of the three components is normalized to 0-1 before weighting -- season
 * PF and recent form against the strongest team's value, all-play win% is
 * already a fraction -- so the weights mean what they say regardless of the
 * league's scoring scale. When every team has 0 for a component (nobody has
 * played), that component contributes 0 rather than dividing by zero.
 */
export function powerRankings(
  teams: PowerTeamInput[],
  weekScores: TeamWeekScore[],
): PowerRankingEntry[] {
  const scoresByTeam = new Map<string, TeamWeekScore[]>();
  for (const s of weekScores) {
    const list = scoresByTeam.get(s.teamId) ?? [];
    list.push(s);
    scoresByTeam.set(s.teamId, list);
  }

  const allPlay = allPlayWinPcts(weekScores);

  const base = teams.map((t) => ({
    teamId: t.teamId,
    seasonPf: t.pointsFor,
    recentForm: recentFormFor(scoresByTeam.get(t.teamId) ?? []),
    allPlayWinPct: allPlay.get(t.teamId) ?? 0,
  }));

  const maxPf = Math.max(0, ...base.map((b) => b.seasonPf));
  const maxForm = Math.max(0, ...base.map((b) => b.recentForm));

  const scored = base.map((b) => {
    const normPf = maxPf > 0 ? b.seasonPf / maxPf : 0;
    const normForm = maxForm > 0 ? b.recentForm / maxForm : 0;
    const blend =
      WEIGHT_SEASON_PF * normPf +
      WEIGHT_ALL_PLAY * b.allPlayWinPct +
      WEIGHT_RECENT_FORM * normForm;
    return {
      ...b,
      recentForm: round1(b.recentForm),
      powerScore: round1(100 * blend),
    };
  });

  scored.sort(
    (a, b) =>
      b.powerScore - a.powerScore ||
      b.seasonPf - a.seasonPf ||
      (a.teamId < b.teamId ? -1 : a.teamId > b.teamId ? 1 : 0),
  );

  return scored.map((s, i) => ({
    teamId: s.teamId,
    rank: i + 1,
    powerScore: s.powerScore,
    seasonPf: s.seasonPf,
    recentForm: s.recentForm,
    allPlayWinPct: s.allPlayWinPct,
  }));
}
