/**
 * Head-to-head history (T-082).
 *
 *   npm test
 *
 * headToHead tallies the series record between two teams over their
 * finalized meetings. The contract these fixtures pin:
 *
 *   - A leads, B leads, and a level series ("tied") are reported from A's side;
 *   - no finalized meeting yields 0-0-0 and "none" (the first-meeting case);
 *   - a drawn game counts as a tie, not a win for either side;
 *   - both home/away orientations of the pairing are counted;
 *   - unfinished games, byes and games involving a third team are ignored.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  headToHead,
  type HeadToHeadMatchup,
} from "../src/lib/head-to-head.ts";

/** A finalized meeting between `home` and `away`. */
function game(
  home: string,
  homeScore: number,
  away: string | null,
  awayScore: number,
  status: HeadToHeadMatchup["status"] = "final",
): HeadToHeadMatchup {
  return { homeTeamId: home, awayTeamId: away, homeScore, awayScore, status };
}

describe("headToHead", () => {
  test("team A leads the series", () => {
    const s = headToHead("A", "B", [
      game("A", 100, "B", 90),
      game("B", 80, "A", 95),
      game("A", 70, "B", 88),
    ]);
    assert.deepEqual(
      { ...s },
      { teamAWins: 2, teamBWins: 1, ties: 0, meetings: 3, leader: "a" },
    );
  });

  test("team B leads the series", () => {
    const s = headToHead("A", "B", [
      game("A", 90, "B", 100),
      game("B", 110, "A", 95),
    ]);
    assert.equal(s.leader, "b");
    assert.equal(s.teamAWins, 0);
    assert.equal(s.teamBWins, 2);
  });

  test("a level series reads tied", () => {
    const s = headToHead("A", "B", [
      game("A", 100, "B", 90),
      game("B", 100, "A", 90),
    ]);
    assert.equal(s.leader, "tied");
    assert.equal(s.teamAWins, 1);
    assert.equal(s.teamBWins, 1);
    assert.equal(s.meetings, 2);
  });

  test("no finalized meeting is 0-0-0 and 'none'", () => {
    const s = headToHead("A", "B", []);
    assert.deepEqual(
      { ...s },
      { teamAWins: 0, teamBWins: 0, ties: 0, meetings: 0, leader: "none" },
    );
  });

  test("a drawn game counts as a tie", () => {
    const s = headToHead("A", "B", [
      game("A", 100, "B", 100),
      game("A", 101, "B", 100),
    ]);
    assert.equal(s.ties, 1);
    assert.equal(s.teamAWins, 1);
    assert.equal(s.teamBWins, 0);
    // One win apiece would be "tied"; here A is up 1-0 with a draw aside.
    assert.equal(s.leader, "a");
  });

  test("both home and away orientations count", () => {
    const s = headToHead("A", "B", [
      game("A", 120, "B", 100), // A home, A wins
      game("B", 90, "A", 110), // A away, A wins
    ]);
    assert.equal(s.teamAWins, 2);
    assert.equal(s.teamBWins, 0);
  });

  test("unfinished games, byes and third teams are ignored", () => {
    const s = headToHead("A", "B", [
      game("A", 100, "B", 90, "in_progress"), // not final
      game("A", 50, "B", 40, "scheduled"), // not final
      game("A", 130, null, 0), // A bye
      game("A", 100, "C", 90), // third team
      game("C", 70, "B", 60), // neither is A
      game("A", 111, "B", 100), // the only countable meeting
    ]);
    assert.equal(s.meetings, 1);
    assert.equal(s.teamAWins, 1);
    assert.equal(s.leader, "a");
  });
});
