/**
 * T-063 edge cases for summarizeBreakdown, on top of
 * scripts/score-breakdown.test.ts.
 *
 *   npm test
 *
 * These pin the reconciliation invariant on the harder inputs the demo
 * league ("Fake Test League") actually stores -- a seven-line head-coach
 * week, sub-0.1 OL/passing per-yard rules, and a net-negative week -- plus
 * a randomised property so any future change to summarizeBreakdown that
 * breaks "the itemised lines sum to the player's total" fails here.
 *
 * The reviewer flagged a display-only rounding edge (each Points line and
 * the Total are each rounded to 1 dp independently, so two sub-0.1 lines
 * in one week could show a 0.1 visual mismatch). That rounding happens in
 * the client component, not in summarizeBreakdown; at the data layer the
 * lines always reconcile exactly, which is what is pinned here. The
 * "sub-0.1 line is kept" test documents that a tiny contribution survives
 * in the data even though the UI renders it as a rounded 0.0.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { summarizeBreakdown } from "../src/lib/score-breakdown.ts";
import type { ScoreBreakdownEntry } from "../src/lib/types.ts";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** A breakdown entry exactly as the scoring engine stores it. */
function line(value: number, points: number): ScoreBreakdownEntry {
  return { value, points: round2(points) };
}

describe("summarizeBreakdown reconciles on the demo league's harder weeks", () => {
  test("a net-negative week keeps every line and totals negative", () => {
    const { lines, total } = summarizeBreakdown({
      interceptions_thrown: line(2, 2 * -2), // -4
      fumbles_lost: line(1, 1 * -2), // -2
      passing_yards: line(40, 40 * 0.04), // +1.6
    });

    assert.equal(lines.length, 3, "a line went missing from a losing week");
    assert.equal(total, -4.4);

    // Biggest contribution first, so the single positive leads the losses.
    assert.deepEqual(
      lines.map((l) => l.key),
      ["passing_yards", "fumbles_lost", "interceptions_thrown"],
    );
  });

  test("a seven-line head-coach week sums at two places", () => {
    // Shapes the HC_SF / coach_* week the demo league stores: one per-yard
    // 2 dp line (coach_offensive_yards 0.02) among whole-point lines.
    const { lines, total } = summarizeBreakdown({
      coach_win: line(1, 5),
      coach_win_margin: line(14, 14),
      coach_win_streak: line(3, 3),
      coach_comeback_4q: line(1, 4),
      coach_offensive_yards: line(417, 417 * 0.02), // 8.34
      coach_turnovers_forced: line(2, 4),
      coach_turnovers_committed: line(1, -1),
    });

    assert.equal(lines.length, 7);
    assert.equal(total, round2(5 + 14 + 3 + 4 + 8.34 + 4 - 1)); // 37.34
    const byHand = round2(lines.reduce((s, l) => s + l.points, 0));
    assert.equal(byHand, total);
  });

  test("a sub-0.1 line is kept in the data, not dropped", () => {
    // ol_passing_yards is 0.01/yd in the demo league: 3 yds -> 0.03, which
    // the UI rounds to a displayed "+0.0" but must still carry in the data.
    const { lines, total } = summarizeBreakdown({
      ol_passing_yards: line(3, 3 * 0.01), // 0.03
      passing_tds: line(1, 4),
    });

    assert.equal(lines.length, 2, "the tiny contribution was dropped");
    const ol = lines.find((l) => l.key === "ol_passing_yards");
    assert.ok(ol, "ol_passing_yards should remain");
    assert.equal(ol.points, 0.03);
    assert.equal(total, 4.03);
  });
});

describe("summarizeBreakdown: the lines always sum to the total", () => {
  test("holds across randomised breakdowns (2 dp, mixed per-point rules)", () => {
    const perPoint = [
      0.01, 0.02, 0.04, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 4, 6, -0.25, -1, -2,
    ];
    for (let i = 0; i < 3000; i++) {
      const n = 1 + Math.floor(Math.random() * 8);
      const breakdown: Record<string, ScoreBreakdownEntry> = {};
      for (let j = 0; j < n; j++) {
        const value = Math.floor(Math.random() * 450);
        const rule = perPoint[Math.floor(Math.random() * perPoint.length)];
        breakdown[`stat_${j}`] = line(value, value * rule);
      }

      const { lines, total } = summarizeBreakdown(breakdown);

      assert.equal(
        lines.length,
        Object.keys(breakdown).length,
        "a scored stat vanished",
      );
      const byHand = round2(lines.reduce((s, l) => s + l.points, 0));
      assert.equal(
        total,
        byHand,
        "lines stopped summing to the reported total",
      );
      // Non-increasing by points: the box-score order.
      for (let k = 1; k < lines.length; k++) {
        assert.ok(
          lines[k - 1].points >= lines[k].points,
          "lines are not ordered biggest-first",
        );
      }
    }
  });
});
