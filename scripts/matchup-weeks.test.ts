/**
 * Finding the matchup for a week when matchups can span several (T-009).
 *
 *   npm test
 *
 * A matchup covers week..week + week_count - 1. Every page that shows
 * "the matchup for week W" goes through src/lib/matchup-weeks.ts, which
 * narrows the query by start week and then makes the exact call in
 * code. The pure half is tested directly; the database half runs the
 * same narrowing against real matchup rows and checks it agrees with
 * the span test the scoring functions use in SQL.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, type TestDb } from "./lib/test-db.ts";
import { SEASON, buildLeague, type Fixture } from "./lib/fixtures.ts";
import {
  MAX_MATCHUP_WEEKS,
  candidateStartWeeks,
  matchupCoversWeek,
  matchupEndWeek,
  matchupSpanLabel,
  matchupWeekIndex,
  matchupWeekOfLabel,
  matchupWeeks,
  matchupWinner,
  parseMatchupView,
} from "../src/lib/matchup-weeks.ts";
import type { Matchup } from "../src/lib/types.ts";

const threeWeek = { week: 15, week_count: 3 };
const singleWeek = { week: 10, week_count: 1 };

describe("matchup span (pure)", () => {
  test("a 3-week matchup covers its first, middle and last week", () => {
    assert.equal(matchupCoversWeek(threeWeek, 15), true);
    assert.equal(matchupCoversWeek(threeWeek, 16), true);
    assert.equal(matchupCoversWeek(threeWeek, 17), true);
  });

  test("a 3-week matchup does not cover the week before or after", () => {
    assert.equal(matchupCoversWeek(threeWeek, 14), false);
    assert.equal(matchupCoversWeek(threeWeek, 18), false);
  });

  test("a single-week matchup covers only its own week", () => {
    assert.equal(matchupCoversWeek(singleWeek, 9), false);
    assert.equal(matchupCoversWeek(singleWeek, 10), true);
    assert.equal(matchupCoversWeek(singleWeek, 11), false);
  });

  test("weeks, end week and position inside the span", () => {
    assert.deepEqual(matchupWeeks(threeWeek), [15, 16, 17]);
    assert.deepEqual(matchupWeeks(singleWeek), [10]);
    assert.equal(matchupEndWeek(threeWeek), 17);
    assert.equal(matchupEndWeek(singleWeek), 10);
    assert.equal(matchupWeekIndex(threeWeek, 15), 1);
    assert.equal(matchupWeekIndex(threeWeek, 17), 3);
    assert.equal(matchupWeekIndex(threeWeek, 18), null);
  });

  test("labels", () => {
    assert.equal(matchupSpanLabel(threeWeek), "Weeks 15–17");
    assert.equal(matchupSpanLabel(singleWeek), "Week 10");
    assert.equal(matchupWeekOfLabel(threeWeek, 16), "Week 2 of 3");
    assert.equal(matchupWeekOfLabel(threeWeek, 14), null);
    assert.equal(matchupWeekOfLabel(singleWeek, 10), null);
  });

  test("the matchup page's ?week= picks a covered week or the total", () => {
    assert.equal(parseMatchupView(threeWeek, undefined), "total");
    assert.equal(parseMatchupView(threeWeek, "total"), "total");
    assert.equal(parseMatchupView(threeWeek, "16"), 16);
    assert.equal(parseMatchupView(threeWeek, ["17", "15"]), 17);
    assert.equal(parseMatchupView(threeWeek, "14"), "total");
    assert.equal(parseMatchupView(threeWeek, "18"), "total");
    assert.equal(parseMatchupView(threeWeek, "15.5"), "total");
    assert.equal(parseMatchupView(threeWeek, "abc"), "total");
    // A single-week matchup has nothing to split.
    assert.equal(parseMatchupView(singleWeek, "10"), "total");
  });

  test("the start-week window reaches back far enough for the longest span", () => {
    const longest = { week: 13, week_count: MAX_MATCHUP_WEEKS };
    const last = matchupEndWeek(longest);
    const { from, to } = candidateStartWeeks(last);
    assert.ok(longest.week >= from && longest.week <= to);
  });
});

describe("matchup winner", () => {
  const game = (
    status: Matchup["status"],
    home: number,
    away: number,
    awayTeam: string | null = "away-team",
  ) => ({
    status,
    home_score: home,
    away_score: away,
    away_team_id: awayTeam,
  });

  test("the higher score wins once final", () => {
    assert.equal(matchupWinner(game("final", 110, 90)), "home");
    assert.equal(matchupWinner(game("final", 90, 110)), "away");
  });

  test("a tied final has no winner on either side", () => {
    assert.equal(matchupWinner(game("final", 100, 100)), null);
    assert.equal(matchupWinner(game("final", 0, 0)), null);
  });

  test("nobody has won a matchup that is not final", () => {
    assert.equal(matchupWinner(game("in_progress", 110, 90)), null);
    assert.equal(matchupWinner(game("scheduled", 0, 0)), null);
  });

  test("the away side of a bye never wins", () => {
    assert.equal(matchupWinner(game("final", 0, 5, null)), null);
    assert.equal(matchupWinner(game("final", 80, 0, null)), "home");
  });
});

describe("matchup span (database)", () => {
  let db: TestDb;
  let f: Fixture;
  let threeWeekId: string;
  let singleWeekId: string;
  let longestId: string;

  before(async () => {
    db = await createTestDb();
    f = await buildLeague(db, "matchup-weeks");

    const insert = async (
      week: number,
      weekCount: number,
      home: string,
      away: string,
    ) =>
      (
        await db.one<{ id: string }>(
          `insert into public.matchups
             (league_id, season, week, week_count, home_team_id,
              away_team_id, is_playoff)
           values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [f.leagueId, SEASON, week, weekCount, home, away, weekCount > 1],
        )
      ).id;

    singleWeekId = await insert(10, 1, f.teamIds[0], f.teamIds[1]);
    threeWeekId = await insert(15, 3, f.teamIds[0], f.teamIds[1]);
    longestId = await insert(15, MAX_MATCHUP_WEEKS, f.teamIds[2], f.teamIds[3]);
  });

  after(async () => {
    await db.close();
  });

  /** What fetchMatchupsCoveringWeek does: narrow by start week, then filter. */
  async function covering(week: number, teamId?: string): Promise<string[]> {
    const { from, to } = candidateStartWeeks(week);
    const rows = await db.q<Matchup>(
      `select * from public.matchups
        where league_id = $1 and season = $2
          and week >= $3 and week <= $4
          and ($5::uuid is null or home_team_id = $5 or away_team_id = $5)`,
      [f.leagueId, SEASON, from, to, teamId ?? null],
    );
    return rows
      .filter((m) => matchupCoversWeek(m, week))
      .map((m) => m.id)
      .sort();
  }

  /** The span test the scoring functions use, straight from SQL. */
  async function coveringInSql(week: number, teamId?: string): Promise<string[]> {
    const rows = await db.q<{ id: string }>(
      `select id from public.matchups
        where league_id = $1 and season = $2
          and $3 between week and week + week_count - 1
          and ($4::uuid is null or home_team_id = $4 or away_team_id = $4)
        order by id`,
      [f.leagueId, SEASON, week, teamId ?? null],
    );
    return rows.map((r) => r.id).sort();
  }

  async function assertTeam0(week: number, expected: string[]) {
    const team = f.teamIds[0];
    assert.deepEqual(await covering(week, team), [...expected].sort());
    assert.deepEqual(await covering(week, team), await coveringInSql(week, team));
  }

  test("3-week matchup: first, middle and last week find it", async () => {
    await assertTeam0(15, [threeWeekId]);
    await assertTeam0(16, [threeWeekId]);
    await assertTeam0(17, [threeWeekId]);
  });

  test("3-week matchup: the week before and after do not", async () => {
    await assertTeam0(14, []);
    await assertTeam0(18, []);
  });

  test("single-week matchup: only its own week", async () => {
    await assertTeam0(9, []);
    await assertTeam0(10, [singleWeekId]);
    await assertTeam0(11, []);
  });

  test("league-wide lookups agree with SQL in every week", async () => {
    for (let week = 1; week <= 20; week++) {
      assert.deepEqual(
        await covering(week),
        await coveringInSql(week),
        `week ${week}`,
      );
    }
    // The longest allowed span is still found in its last week.
    assert.deepEqual(await covering(18), [longestId]);
  });
});
