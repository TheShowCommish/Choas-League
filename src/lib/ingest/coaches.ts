import "server-only";

import { n, s, streamCsv } from "./csv.ts";
import { normalizeTeam, nflverseUrls } from "./nflverse.ts";
import type { StatMap } from "./map-stats.ts";
import {
  buildCoachStats,
  type CoachGame,
  type Fixture,
  type TeamBoxScore,
} from "./coach-stats.ts";

export { coachPlayerRows } from "./coach-stats.ts";
export type { CoachGame, Fixture, TeamBoxScore } from "./coach-stats.ts";

/**
 * Reading the feeds a head coach's stat line is built from.
 *
 * The arithmetic lives in coach-stats.ts, which has no network in it and
 * so can be tested directly. This half only fetches:
 *
 *   schedules        who coached, and the result
 *   stats_team_week  offensive yards and turnovers
 *
 * The fourth-quarter comeback comes from play-by-play, collected in the
 * pass that is already streaming that file.
 */

const GAME_TYPE_TO_SEASON_TYPE: Record<string, string> = {
  REG: "REG",
  PRE: "PRE",
  WC: "POST",
  DIV: "POST",
  CON: "POST",
  SB: "POST",
};

/** One row per team per game. */
async function readFixtures(season: number): Promise<Fixture[]> {
  const out: Fixture[] = [];

  for await (const row of streamCsv(nflverseUrls.games())) {
    if (n(row, "season") !== season) continue;

    const gameId = s(row, "game_id");
    const home = normalizeTeam(s(row, "home_team"));
    const away = normalizeTeam(s(row, "away_team"));
    if (!gameId || !home || !away) continue;

    const seasonType =
      GAME_TYPE_TO_SEASON_TYPE[s(row, "game_type") ?? "REG"] ?? "REG";
    if (seasonType === "PRE") continue;

    // A fixture with no score has not been played. It is carried through
    // rather than dropped so that a streak is not broken by a game that
    // has not happened.
    const homeScore = s(row, "home_score");
    const awayScore = s(row, "away_score");
    const played =
      homeScore !== null &&
      homeScore !== "" &&
      awayScore !== null &&
      awayScore !== "";

    const week = n(row, "week");
    const homeCoach = s(row, "home_coach");
    const awayCoach = s(row, "away_coach");

    if (homeCoach) {
      out.push({
        gameId,
        season,
        week,
        seasonType,
        team: home,
        opponent: away,
        coach: homeCoach,
        pointsFor: n(row, "home_score"),
        pointsAgainst: n(row, "away_score"),
        played,
      });
    }
    if (awayCoach) {
      out.push({
        gameId,
        season,
        week,
        seasonType,
        team: away,
        opponent: home,
        coach: awayCoach,
        pointsFor: n(row, "away_score"),
        pointsAgainst: n(row, "home_score"),
        played,
      });
    }
  }

  return out;
}

/** Offensive yards and turnovers, per team per game. */
async function readTeamBoxScores(
  season: number,
): Promise<Map<string, TeamBoxScore>> {
  const out = new Map<string, TeamBoxScore>();

  for await (const row of streamCsv(nflverseUrls.teamWeek(season))) {
    if ((s(row, "season_type") ?? "REG") === "PRE") continue;

    const team = normalizeTeam(s(row, "team"));
    const gameId = s(row, "game_id");
    if (!team || !gameId) continue;

    out.set(`${team}|${gameId}`, {
      yards: n(row, "passing_yards") + n(row, "rushing_yards"),
      committed:
        n(row, "passing_interceptions") +
        n(row, "sack_fumbles_lost") +
        n(row, "rushing_fumbles_lost") +
        n(row, "receiving_fumbles_lost"),
      forced: n(row, "def_interceptions") + n(row, "fumble_recovery_opp"),
    });
  }

  return out;
}

export async function buildCoachGames(
  season: number,
  week: number | null,
  comebacks: Map<string, StatMap>,
): Promise<CoachGame[]> {
  return buildCoachStats(
    await readFixtures(season),
    await readTeamBoxScores(season),
    comebacks,
    week,
  );
}
