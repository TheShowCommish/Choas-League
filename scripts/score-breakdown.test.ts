/**
 * The matchup player breakdown (T-063).
 *
 *   npm test
 *
 * A player's week, tapped open, lists every stat that scored and the
 * points it added. The lines come from `player_week_scores.breakdown`,
 * the jsonb the scoring engine writes in the same pass it computes the
 * total (recompute_week_scores, 0012). summarizeBreakdown only reads that
 * back, so the lines must always add up to the player's stored total --
 * that reconciliation is what these fixtures pin.
 *
 * Each fixture is a representative stat line, the per-stat points written
 * exactly as the engine writes them (round(value * rule.points, 2) using
 * the catalog defaults), and the total the player row shows. The test
 * proves the lines sum to that total and that the labels and signs read
 * right.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { summarizeBreakdown } from "../src/lib/score-breakdown.ts";
import type { ScoreBreakdownEntry } from "../src/lib/types.ts";

/** Build a breakdown entry the way the engine stores it. */
function line(value: number, points: number): ScoreBreakdownEntry {
  return { value, points: Math.round(points * 100) / 100 };
}

interface Fixture {
  name: string;
  /** The jsonb the engine wrote for this player-week. */
  breakdown: Record<string, ScoreBreakdownEntry>;
  /** The total on player_week_scores.points, i.e. the number the row shows. */
  storedTotal: number;
}

// Catalog defaults in play: passing_yards 0.04, passing_tds 4,
// interceptions_thrown -2, rushing_yards 0.1, rushing_tds 6, receptions 1,
// receiving_yards 0.1, receiving_tds 6, fumbles_lost -2, fg_made 3,
// fg_made_40_49 1, fg_made_50_59 2, pat_made 1, fg_missed -1, dst_sacks 1,
// dst_interceptions 2, dst_fumble_recoveries 2, dst_tds 6, dst_pa_7_13 4.
const FIXTURES: Fixture[] = [
  {
    name: "a QB passing, rushing and throwing a pick",
    breakdown: {
      passing_yards: line(312, 312 * 0.04),
      passing_tds: line(2, 2 * 4),
      rushing_yards: line(28, 28 * 0.1),
      interceptions_thrown: line(1, 1 * -2),
    },
    storedTotal: 21.28,
  },
  {
    name: "an RB with a rushing TD and a few catches",
    breakdown: {
      rushing_yards: line(96, 96 * 0.1),
      rushing_tds: line(1, 1 * 6),
      receptions: line(3, 3 * 1),
      receiving_yards: line(24, 24 * 0.1),
    },
    storedTotal: 21,
  },
  {
    name: "a WR who scored but also lost a fumble",
    breakdown: {
      receptions: line(7, 7 * 1),
      receiving_yards: line(112, 112 * 0.1),
      receiving_tds: line(1, 1 * 6),
      fumbles_lost: line(1, 1 * -2),
    },
    storedTotal: 22.2,
  },
  {
    name: "a kicker with makes, bonuses and a miss",
    breakdown: {
      fg_made: line(3, 3 * 3),
      fg_made_40_49: line(1, 1 * 1),
      fg_made_50_59: line(1, 1 * 2),
      pat_made: line(2, 2 * 1),
      fg_missed: line(1, 1 * -1),
    },
    storedTotal: 13,
  },
  {
    name: "a D/ST with turnovers, a score and a points-allowed tier",
    breakdown: {
      dst_sacks: line(4, 4 * 1),
      dst_interceptions: line(2, 2 * 2),
      dst_fumble_recoveries: line(1, 1 * 2),
      dst_tds: line(1, 1 * 6),
      dst_pa_7_13: line(1, 1 * 4),
    },
    storedTotal: 20,
  },
];

describe("matchup player breakdown reconciles to the total", () => {
  for (const fixture of FIXTURES) {
    test(fixture.name, () => {
      const { lines, total } = summarizeBreakdown(fixture.breakdown);

      // Every scored stat shows up as a line.
      assert.equal(
        lines.length,
        Object.keys(fixture.breakdown).length,
        "a scored stat went missing from the breakdown",
      );

      // The lines add up to exactly the number the player row shows.
      assert.equal(
        total,
        fixture.storedTotal,
        "the itemised lines do not sum to the player's stored total",
      );

      // And summing them by hand agrees too (no hidden rounding drift).
      const byHand =
        Math.round(lines.reduce((s, l) => s + l.points, 0) * 100) / 100;
      assert.equal(byHand, fixture.storedTotal);
    });
  }
});

describe("breakdown lines read the way the report needs", () => {
  test("stat keys become their catalog labels", () => {
    const { lines } = summarizeBreakdown({
      passing_yards: line(312, 12.48),
      rushing_tds: line(1, 6),
    });
    const labels = new Map(lines.map((l) => [l.key, l.label]));
    assert.equal(labels.get("passing_yards"), "Passing Yards");
    assert.equal(labels.get("rushing_tds"), "Rushing TDs");
  });

  test("an unknown stat key still shows, as its key", () => {
    const { lines } = summarizeBreakdown({ some_new_stat: line(2, 4) });
    assert.equal(lines[0].label, "some_new_stat");
    assert.equal(lines[0].points, 4);
  });

  test("the biggest contribution leads, negatives sink", () => {
    const { lines } = summarizeBreakdown({
      interceptions_thrown: line(1, -2),
      passing_tds: line(2, 8),
      rushing_yards: line(28, 2.8),
    });
    assert.deepEqual(
      lines.map((l) => l.key),
      ["passing_tds", "rushing_yards", "interceptions_thrown"],
    );
  });

  test("a negative line is kept, not dropped", () => {
    const { lines, total } = summarizeBreakdown({
      receiving_tds: line(1, 6),
      fumbles_lost: line(1, -2),
    });
    const fumble = lines.find((l) => l.key === "fumbles_lost");
    assert.ok(fumble, "the fumble should remain in the breakdown");
    assert.equal(fumble.points, -2);
    assert.equal(total, 4);
  });

  test("a bye / no-stats week is an empty breakdown of zero", () => {
    assert.deepEqual(summarizeBreakdown({}), { lines: [], total: 0 });
    assert.deepEqual(summarizeBreakdown(null), { lines: [], total: 0 });
    assert.deepEqual(summarizeBreakdown(undefined), { lines: [], total: 0 });
  });
});
