/**
 * Which weeks a matchup covers.
 *
 * A playoff round can span several weeks: a matchup row stores its
 * first `week` and a `week_count`, and is being played in every week
 * from week to week + week_count - 1. Looking a matchup up with
 * `week = selectedWeek` therefore misses it in every week but the
 * first, so every page that finds "the matchup for week W" goes
 * through here instead.
 *
 * Pure apart from `fetchMatchupsCoveringWeek`, and that only takes the
 * client it is given, so the tests can import this file directly.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Matchup } from "@/lib/types";

/** The most weeks a matchup can span (the check on matchups.week_count). */
export const MAX_MATCHUP_WEEKS = 4;

const EN_DASH = String.fromCharCode(0x2013);

type Span =Pick<Matchup, "week" | "week_count">;

function countOf(matchup: Span): number {
  return Math.max(1, matchup.week_count ?? 1);
}

/** The last week the matchup is played in. */
export function matchupEndWeek(matchup: Span): number {
  return matchup.week + countOf(matchup) - 1;
}

/** Every week the matchup covers, in order. */
export function matchupWeeks(matchup: Span): number[] {
  return Array.from({ length: countOf(matchup) }, (_, i) => matchup.week + i);
}

/** week <= W <= week + week_count - 1. */
export function matchupCoversWeek(matchup: Span, week: number): boolean {
  return week >= matchup.week && week <= matchupEndWeek(matchup);
}

/** 1-based position of `week` inside the matchup, or null if outside it. */
export function matchupWeekIndex(matchup: Span, week: number): number | null {
  return matchupCoversWeek(matchup, week) ? week - matchup.week + 1 : null;
}

/** "Week 3", or "Weeks 15-16" for a matchup that spans several. */
export function matchupSpanLabel(matchup: Span): string {
  return countOf(matchup) > 1
    ? `Weeks ${matchup.week}${EN_DASH}${matchupEndWeek(matchup)}`
    : `Week ${matchup.week}`;
}

/**
 * "Week 2 of 2" for a week inside a multi-week matchup. Null for a
 * single-week matchup, where it would only repeat itself, and for a
 * week outside the span.
 */
export function matchupWeekOfLabel(matchup: Span, week: number): string | null {
  const index = matchupWeekIndex(matchup, week);
  if (index === null || countOf(matchup) === 1) return null;
  return `Week ${index} of ${countOf(matchup)}`;
}

/**
 * The start weeks a matchup covering `week` can have. Narrows the query
 * before `matchupCoversWeek` makes the exact call, since PostgREST
 * cannot filter on week + week_count.
 */
export function candidateStartWeeks(week: number): { from: number; to: number } {
  return { from: week - MAX_MATCHUP_WEEKS + 1, to: week };
}

/**
 * Reads the `?week=` of the matchup page: one week inside the span, or
 * "total" for the whole matchup. Anything missing, unreadable or
 * outside the span is the total, and a single-week matchup only ever
 * has the total.
 */
export function parseMatchupView(
  matchup: Span,
  raw: string | string[] | undefined,
): number | "total" {
  if (countOf(matchup) === 1) return "total";
  const value = Array.isArray(raw) ? raw[0] : raw;
  const week = Number(value);
  return Number.isInteger(week) && matchupCoversWeek(matchup, week)
    ? week
    : "total";
}

/**
 * The league's matchups being played in `week`, including those that
 * started in an earlier week and are still running. Pass `teamId` for
 * only that team's.
 */
export async function fetchMatchupsCoveringWeek(
  // The server and browser clients are typed with different generics.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  {
    leagueId,
    season,
    week,
    teamId,
  }: { leagueId: string; season: number; week: number; teamId?: string },
): Promise<Matchup[]> {
  const { from, to } = candidateStartWeeks(week);

  let query = supabase
    .from("matchups")
    .select("*")
    .eq("league_id", leagueId)
    .eq("season", season)
    .gte("week", from)
    .lte("week", to);

  if (teamId) {
    query = query.or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`);
  }

  const { data } = await query;
  return ((data ?? []) as Matchup[]).filter((m) =>
    matchupCoversWeek(m, week),
  );
}

/**
 * Which side has won a matchup: only once it is final, and never on a
 * tie. The away side cannot win a bye.
 */
export function matchupWinner(
  matchup: Pick<
    Matchup,
    "status" | "home_score" | "away_score" | "away_team_id"
  >,
): "home" | "away" | null {
  if (matchup.status !== "final") return null;
  const home = Number(matchup.home_score);
  const away = Number(matchup.away_score);
  if (home > away) return "home";
  if (away > home && matchup.away_team_id !== null) return "away";
  return null;
}
