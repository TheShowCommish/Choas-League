/**
 * Head coach stat lines, and above all the streaks.
 *
 * Streaks are the only part of the scoring engine that depends on
 * anything outside the game in front of it, so they get the most
 * attention here.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildCoachStats,
  coachPlayerRows,
  type Fixture,
  type TeamBoxScore,
} from "../src/lib/ingest/coach-stats.ts";

const SEASON = 2025;

function fixture(
  week: number,
  team: string,
  coach: string,
  pointsFor: number,
  pointsAgainst: number,
  played = true,
): Fixture {
  return {
    gameId: `${SEASON}_${String(week).padStart(2, "0")}_${team}`,
    season: SEASON,
    week,
    seasonType: "REG",
    team,
    opponent: "OPP",
    coach,
    pointsFor,
    pointsAgainst,
    played,
  };
}

const noBox = new Map<string, TeamBoxScore>();
const noComebacks = new Map();

/** The stat map for one week of one team. */
function statsFor(games: ReturnType<typeof buildCoachStats>, week: number) {
  const found = games.find((g) => g.week === week);
  assert.ok(found, `no game for week ${week}`);
  return found.stats;
}

describe("head coach stats", () => {
  test("a winning run counts up and a defeat resets it", () => {
    const games = buildCoachStats(
      [
        fixture(1, "KC", "Andy Reid", 30, 10),
        fixture(2, "KC", "Andy Reid", 24, 20),
        fixture(3, "KC", "Andy Reid", 14, 21),
        fixture(4, "KC", "Andy Reid", 28, 7),
      ],
      noBox,
      noComebacks,
      null,
    );

    assert.equal(statsFor(games, 1).coach_win_streak, 1);
    assert.equal(statsFor(games, 2).coach_win_streak, 2);
    assert.equal(statsFor(games, 3).coach_win_streak, 0, "a defeat ends it");
    assert.equal(statsFor(games, 3).coach_loss_streak, 1);
    assert.equal(statsFor(games, 4).coach_win_streak, 1, "and it starts again");
    assert.equal(statsFor(games, 4).coach_loss_streak, 0);
  });

  test("a tie ends both runs without starting one", () => {
    const games = buildCoachStats(
      [
        fixture(1, "NYG", "Coach", 20, 3),
        fixture(2, "NYG", "Coach", 17, 17),
        fixture(3, "NYG", "Coach", 10, 30),
      ],
      noBox,
      noComebacks,
      null,
    );

    assert.equal(statsFor(games, 2).coach_win_streak, 0);
    assert.equal(statsFor(games, 2).coach_loss_streak, 0);
    assert.equal(statsFor(games, 2).coach_tie, 1);
    assert.equal(statsFor(games, 3).coach_loss_streak, 1);
  });

  test("an unplayed fixture does not break a run", () => {
    const games = buildCoachStats(
      [
        fixture(1, "SF", "Coach", 24, 10),
        fixture(2, "SF", "Coach", 0, 0, false),
        fixture(3, "SF", "Coach", 31, 28),
      ],
      noBox,
      noComebacks,
      null,
    );

    assert.equal(games.length, 2, "the unplayed week produces no line");
    assert.equal(statsFor(games, 3).coach_win_streak, 2);
  });

  test("streaks follow the coach, not the club", () => {
    const games = buildCoachStats(
      [
        fixture(1, "CHI", "First Coach", 20, 10),
        fixture(2, "CHI", "First Coach", 20, 10),
        // Sacked. His successor starts from nothing.
        fixture(3, "CHI", "Second Coach", 20, 10),
      ],
      noBox,
      noComebacks,
      null,
    );

    assert.equal(statsFor(games, 2).coach_win_streak, 2);
    assert.equal(statsFor(games, 3).coach_win_streak, 1);
  });

  test("asking for one week still counts the streak from the start", () => {
    const all = [
      fixture(1, "BUF", "Coach", 30, 10),
      fixture(2, "BUF", "Coach", 30, 10),
      fixture(3, "BUF", "Coach", 30, 10),
    ];

    const justWeek3 = buildCoachStats(all, noBox, noComebacks, 3);
    assert.equal(justWeek3.length, 1);
    assert.equal(justWeek3[0].stats.coach_win_streak, 3);
  });

  test("both margins are positive, and only one is set", () => {
    const games = buildCoachStats(
      [
        fixture(1, "DAL", "Coach", 31, 17),
        fixture(2, "DAL", "Coach", 10, 24),
      ],
      noBox,
      noComebacks,
      null,
    );

    assert.equal(statsFor(games, 1).coach_win_margin, 14);
    assert.equal(statsFor(games, 1).coach_loss_margin, 0);
    assert.equal(statsFor(games, 2).coach_win_margin, 0);
    assert.equal(statsFor(games, 2).coach_loss_margin, 14);
  });

  test("yards and turnovers come off the team box score", () => {
    const box = new Map<string, TeamBoxScore>([
      [`KC|${SEASON}_01_KC`, { yards: 412, committed: 2, forced: 3 }],
    ]);

    const games = buildCoachStats(
      [fixture(1, "KC", "Andy Reid", 27, 20)],
      box,
      noComebacks,
      null,
    );

    assert.equal(games[0].stats.coach_offensive_yards, 412);
    assert.equal(games[0].stats.coach_turnovers_committed, 2);
    assert.equal(games[0].stats.coach_turnovers_forced, 3);
  });

  test("a missing box score leaves zeroes rather than blowing up", () => {
    const games = buildCoachStats(
      [fixture(1, "KC", "Andy Reid", 27, 20)],
      noBox,
      noComebacks,
      null,
    );
    assert.equal(games[0].stats.coach_offensive_yards, 0);
  });

  test("the comeback flag is merged in from play-by-play", () => {
    const comebacks = new Map([
      [`HC_KC|${SEASON}_01_KC`, { coach_comeback_4q: 1 }],
    ]);

    const games = buildCoachStats(
      [fixture(1, "KC", "Andy Reid", 27, 20)],
      noBox,
      comebacks,
      null,
    );
    assert.equal(games[0].stats.coach_comeback_4q, 1);
  });

  test("the pseudo-player takes the name of whoever holds the job last", () => {
    const games = buildCoachStats(
      [
        fixture(1, "CHI", "First Coach", 20, 10),
        fixture(9, "CHI", "Second Coach", 20, 10),
      ],
      noBox,
      noComebacks,
      null,
    );

    const rows = coachPlayerRows(games);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "HC_CHI");
    assert.equal(rows[0].full_name, "Second Coach (HC)");
    assert.equal(rows[0].position, "HC");
  });
});
