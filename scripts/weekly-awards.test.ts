/**
 * Weekly trophies / awards (T-076).
 *
 *   npm test
 *
 * weeklyAwards reads a week's finalized matchups and hands back the four
 * trophies. The contract these fixtures pin:
 *
 *   - high score is the biggest single-team score, low score the smallest;
 *   - blowout is the largest winning margin, closest the smallest non-zero
 *     one (a tie is never the closest game);
 *   - ties on any award are broken deterministically by team id;
 *   - a one-game week and a bye are handled (the bye's away side does not
 *     score, and a bye is not a margin);
 *   - a week with nothing finalized yields no trophies.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  weeklyAwards,
  awardsByWeek,
  type AwardMatchup,
} from "../src/lib/weekly-awards.ts";

/** A finalized two-team game. */
function game(
  home: string,
  homeScore: number,
  away: string,
  awayScore: number,
  week = 1,
): AwardMatchup {
  return {
    week,
    homeTeamId: home,
    homeScore,
    awayTeamId: away,
    awayScore,
    status: "final",
  };
}

/** A finalized bye: the home team scores, no opponent. */
function bye(home: string, homeScore: number, week = 1): AwardMatchup {
  return {
    week,
    homeTeamId: home,
    homeScore,
    awayTeamId: null,
    awayScore: 0,
    status: "final",
  };
}

describe("weeklyAwards", () => {
  test("high / low score pick the right teams and points", () => {
    const awards = weeklyAwards([
      game("a", 120, "b", 90),
      game("c", 70, "d", 150),
    ]);
    assert.deepEqual(awards.highScore, { teamId: "d", points: 150 });
    assert.deepEqual(awards.lowScore, { teamId: "c", points: 70 });
  });

  test("blowout is the largest margin, closest the smallest non-zero one", () => {
    const awards = weeklyAwards([
      game("a", 120, "b", 90), // margin 30
      game("c", 100, "d", 98), // margin 2
      game("e", 110, "f", 70), // margin 40
    ]);
    assert.equal(awards.blowout?.margin, 40);
    assert.equal(awards.blowout?.winnerTeamId, "e");
    assert.equal(awards.blowout?.loserTeamId, "f");
    assert.equal(awards.closest?.margin, 2);
    assert.equal(awards.closest?.winnerTeamId, "c");
    assert.equal(awards.closest?.loserScore, 98);
  });

  test("a tie is never the closest game (no winning margin)", () => {
    const awards = weeklyAwards([
      game("a", 100, "b", 100), // tie, margin 0
      game("c", 110, "d", 95), // margin 15
    ]);
    assert.equal(awards.closest?.margin, 15);
    assert.equal(awards.closest?.winnerTeamId, "c");
    assert.equal(awards.blowout?.margin, 15);
  });

  test("all-tie week has no blowout or closest, but still high / low", () => {
    const awards = weeklyAwards([
      game("a", 100, "b", 100),
      game("c", 80, "d", 80),
    ]);
    assert.equal(awards.blowout, null);
    assert.equal(awards.closest, null);
    assert.equal(awards.highScore?.points, 100);
    assert.equal(awards.lowScore?.points, 80);
  });

  test("score ties break by team id ascending", () => {
    const awards = weeklyAwards([
      game("b", 120, "a", 120), // both high
      game("d", 60, "c", 60), // both low
    ]);
    assert.deepEqual(awards.highScore, { teamId: "a", points: 120 });
    assert.deepEqual(awards.lowScore, { teamId: "c", points: 60 });
  });

  test("margin ties break by winning team id ascending", () => {
    const awards = weeklyAwards([
      game("z", 110, "y", 100), // winner z, margin 10
      game("a", 90, "b", 80), // winner a, margin 10
    ]);
    // Both margins are 10; blowout and closest both land on winner "a".
    assert.equal(awards.blowout?.winnerTeamId, "a");
    assert.equal(awards.closest?.winnerTeamId, "a");
  });

  test("a one-game week fills every trophy from that game", () => {
    const awards = weeklyAwards([game("a", 130, "b", 95)]);
    assert.deepEqual(awards.highScore, { teamId: "a", points: 130 });
    assert.deepEqual(awards.lowScore, { teamId: "b", points: 95 });
    assert.equal(awards.blowout?.margin, 35);
    assert.equal(awards.closest?.margin, 35);
  });

  test("a bye counts the home team's score but is not a margin", () => {
    const awards = weeklyAwards([
      game("a", 120, "b", 110),
      bye("c", 40),
    ]);
    // c's bye score is the low score of the week...
    assert.deepEqual(awards.lowScore, { teamId: "c", points: 40 });
    // ...but the only margin comes from the two-team game.
    assert.equal(awards.blowout?.margin, 10);
    assert.equal(awards.blowout?.winnerTeamId, "a");
  });

  test("a week with nothing finalized yields no trophies", () => {
    const awards = weeklyAwards([
      { ...game("a", 0, "b", 0), status: "scheduled" },
      { ...game("c", 0, "d", 0), status: "in_progress" },
    ]);
    assert.deepEqual(awards, {
      highScore: null,
      lowScore: null,
      blowout: null,
      closest: null,
    });
  });

  test("an empty list yields no trophies", () => {
    assert.deepEqual(weeklyAwards([]), {
      highScore: null,
      lowScore: null,
      blowout: null,
      closest: null,
    });
  });
});

describe("awardsByWeek", () => {
  test("groups by week, newest first, dropping weeks with nothing final", () => {
    const rows = awardsByWeek([
      game("a", 120, "b", 90, 1),
      game("c", 100, "d", 80, 2),
      // week 3 scheduled only -> no trophies -> dropped
      { ...game("e", 0, "f", 0, 3), status: "scheduled" },
    ]);
    assert.deepEqual(
      rows.map((r) => r.week),
      [2, 1],
    );
    assert.equal(rows[0].awards.highScore?.teamId, "c");
    assert.equal(rows[1].awards.highScore?.teamId, "a");
  });

  test("an empty season has no weeks", () => {
    assert.deepEqual(awardsByWeek([]), []);
  });
});
