/**
 * Defense-vs-position helpers (T-089).
 *
 *   npm test
 *
 * The pure logic behind the points-allowed drill-down and the opponent
 * matchup rating: drop scoreless weeks, list what a defense gave up by
 * week, and rank all defenses by how much they allow a position.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  defenseRank,
  ordinal,
  pointsAllowed,
  rankDefenses,
  type FacingRow,
} from "../src/lib/defense-vs-position.ts";

/** Build a facing row with sensible defaults. */
function row(partial: Partial<FacingRow> & Pick<FacingRow, "opponent" | "week" | "points">): FacingRow {
  return {
    playerId: partial.playerId ?? `${partial.opponent}-${partial.week}-${partial.points}`,
    playerName: partial.playerName ?? "Some Guy",
    headshotUrl: partial.headshotUrl ?? null,
    opponent: partial.opponent,
    week: partial.week,
    points: partial.points,
  };
}

describe("pointsAllowed", () => {
  const rows: FacingRow[] = [
    row({ playerId: "a", playerName: "QB A", opponent: "MIA", week: 1, points: 22.5 }),
    row({ playerId: "b", playerName: "QB B", opponent: "MIA", week: 2, points: 14 }),
    row({ playerId: "c", playerName: "QB C", opponent: "MIA", week: 3, points: 0 }),
    row({ playerId: "d", playerName: "QB D", opponent: "BUF", week: 1, points: 30 }),
  ];

  test("lists only the chosen team's players, newest week first", () => {
    const result = pointsAllowed(rows, "MIA");
    assert.deepEqual(
      result.map((r) => [r.week, r.playerName]),
      [
        [2, "QB B"],
        [1, "QB A"],
      ],
    );
  });

  test("drops a scoreless week", () => {
    const result = pointsAllowed(rows, "MIA");
    assert.ok(!result.some((r) => r.playerName === "QB C"));
  });

  test("a team nobody scored against comes back empty", () => {
    assert.deepEqual(pointsAllowed(rows, "NYJ"), []);
  });

  test("within a week, the bigger score sorts first", () => {
    const sameWeek: FacingRow[] = [
      row({ playerName: "small", opponent: "MIA", week: 5, points: 8 }),
      row({ playerName: "big", opponent: "MIA", week: 5, points: 25 }),
    ];
    assert.deepEqual(
      pointsAllowed(sameWeek, "MIA").map((r) => r.playerName),
      ["big", "small"],
    );
  });

  test("a negative score is not points allowed", () => {
    const withNeg: FacingRow[] = [
      row({ opponent: "MIA", week: 1, points: -2 }),
      row({ opponent: "MIA", week: 2, points: 5 }),
    ];
    assert.deepEqual(
      pointsAllowed(withNeg, "MIA").map((r) => r.points),
      [5],
    );
  });
});

describe("rankDefenses", () => {
  const rows: FacingRow[] = [
    // MIA gives up the most.
    row({ opponent: "MIA", week: 1, points: 30 }),
    row({ opponent: "MIA", week: 2, points: 20 }),
    // BUF next.
    row({ opponent: "BUF", week: 1, points: 25 }),
    row({ opponent: "BUF", week: 2, points: 10 }),
    // NYJ least, and a zero that must not count or add a game.
    row({ opponent: "NYJ", week: 1, points: 12 }),
    row({ opponent: "NYJ", week: 2, points: 0 }),
  ];

  test("ranks most-allowed first", () => {
    assert.deepEqual(
      rankDefenses(rows).map((d) => [d.team, d.rank]),
      [
        ["MIA", 1],
        ["BUF", 2],
        ["NYJ", 3],
      ],
    );
  });

  test("totals, games and average exclude the zero week", () => {
    const nyj = rankDefenses(rows).find((d) => d.team === "NYJ")!;
    assert.equal(nyj.total, 12);
    assert.equal(nyj.games, 1);
    assert.equal(nyj.avg, 12);
  });

  test("every team carries the same denominator", () => {
    assert.ok(rankDefenses(rows).every((d) => d.teams === 3));
  });

  test("ties break deterministically by average then team", () => {
    const tied: FacingRow[] = [
      // Same 20 total; CLE has the higher single-game average.
      row({ opponent: "CLE", week: 1, points: 20 }),
      row({ opponent: "PIT", week: 1, points: 12 }),
      row({ opponent: "PIT", week: 2, points: 8 }),
    ];
    assert.deepEqual(
      rankDefenses(tied).map((d) => [d.team, d.rank]),
      [
        ["CLE", 1],
        ["PIT", 2],
      ],
    );
  });
});

describe("defenseRank", () => {
  const rows: FacingRow[] = [
    row({ opponent: "MIA", week: 1, points: 30 }),
    row({ opponent: "BUF", week: 1, points: 10 }),
  ];

  test("returns the one team's place and denominator", () => {
    const r = defenseRank(rows, "BUF")!;
    assert.equal(r.rank, 2);
    assert.equal(r.teams, 2);
  });

  test("null when the team has faced nobody at the position", () => {
    assert.equal(defenseRank(rows, "DAL"), null);
  });
});

describe("ordinal", () => {
  test("common cases", () => {
    assert.equal(ordinal(1), "1st");
    assert.equal(ordinal(2), "2nd");
    assert.equal(ordinal(3), "3rd");
    assert.equal(ordinal(4), "4th");
  });

  test("the 11-13 exceptions", () => {
    assert.equal(ordinal(11), "11th");
    assert.equal(ordinal(12), "12th");
    assert.equal(ordinal(13), "13th");
    assert.equal(ordinal(21), "21st");
  });
});
