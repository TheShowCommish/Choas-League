/**
 * Player compare (T-080).
 *
 *   npm test
 *
 * buildCompareRows turns 2-3 players' comparable numbers into one row per
 * metric and marks the leader. parsePlayerParam cleans the `players` query
 * string. The contract these fixtures pin:
 *
 *   - one row per metric, in COMPARE_METRICS order, carrying each player's
 *     value in the order the players were given;
 *   - the single highest value in a row is the leader (higher is better);
 *   - a tie for the top highlights nobody, and nor does a lone player;
 *   - a null projection never wins and never breaks the row;
 *   - parsePlayerParam de-dupes, drops blanks, keeps order, caps at 3.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildCompareRows,
  parsePlayerParam,
  COMPARE_METRICS,
  MAX_COMPARE,
  type ComparePlayer,
  type ComparePlayerStats,
} from "../src/lib/compare.ts";

/** A player with just the numbers the compare rows turn on. */
function player(id: string, stats: ComparePlayerStats): ComparePlayer {
  return {
    id,
    name: id,
    position: "RB",
    teamAbbr: "KC",
    headshotUrl: null,
    nextOpponent: "DEN",
    stats,
  };
}

describe("buildCompareRows", () => {
  test("one row per metric, in order, with values per player", () => {
    const rows = buildCompareRows([
      player("A", { avg: 12, total: 120, last: 20, projection: 15 }),
      player("B", { avg: 10, total: 110, last: 25, projection: 14 }),
    ]);

    assert.equal(rows.length, COMPARE_METRICS.length);
    assert.deepEqual(
      rows.map((r) => r.key),
      COMPARE_METRICS.map((m) => m.key),
    );
    assert.deepEqual(rows[0].values, [12, 10]);
  });

  test("the single highest value leads each row", () => {
    const rows = buildCompareRows([
      player("A", { avg: 12, total: 120, last: 20, projection: 15 }),
      player("B", { avg: 10, total: 110, last: 25, projection: 14 }),
    ]);
    const best = Object.fromEntries(rows.map((r) => [r.key, r.bestIndex]));

    assert.equal(best.avg, 0); // A
    assert.equal(best.total, 0); // A
    assert.equal(best.last, 1); // B
    assert.equal(best.projection, 0); // A
  });

  test("a tie for the top highlights nobody", () => {
    const rows = buildCompareRows([
      player("A", { avg: 10, total: 100, last: 20, projection: 15 }),
      player("B", { avg: 10, total: 110, last: 25, projection: 14 }),
    ]);
    const avg = rows.find((r) => r.key === "avg");
    assert.equal(avg?.bestIndex, null);
  });

  test("a lone player highlights nobody", () => {
    const rows = buildCompareRows([
      player("A", { avg: 12, total: 120, last: 20, projection: 15 }),
    ]);
    assert.ok(rows.every((r) => r.bestIndex === null));
  });

  test("a null projection never wins and never breaks the row", () => {
    const rows = buildCompareRows([
      player("A", { avg: 12, total: 120, last: 20, projection: null }),
      player("B", { avg: 10, total: 110, last: 25, projection: 8 }),
    ]);
    const proj = rows.find((r) => r.key === "projection");
    assert.deepEqual(proj?.values, [null, 8]);
    assert.equal(proj?.bestIndex, 1); // B, the only one projected
  });

  test("all projections null leaves the row unhighlighted", () => {
    const rows = buildCompareRows([
      player("A", { avg: 12, total: 120, last: 20, projection: null }),
      player("B", { avg: 10, total: 110, last: 25, projection: null }),
    ]);
    const proj = rows.find((r) => r.key === "projection");
    assert.equal(proj?.bestIndex, null);
  });

  test("three players compare side by side", () => {
    const rows = buildCompareRows([
      player("A", { avg: 12, total: 120, last: 20, projection: 15 }),
      player("B", { avg: 10, total: 110, last: 25, projection: 14 }),
      player("C", { avg: 18, total: 90, last: 5, projection: 22 }),
    ]);
    const best = Object.fromEntries(rows.map((r) => [r.key, r.bestIndex]));
    assert.equal(best.avg, 2); // C
    assert.equal(best.total, 0); // A
    assert.equal(best.last, 1); // B
    assert.equal(best.projection, 2); // C
  });
});

describe("parsePlayerParam", () => {
  test("empty or missing yields no ids", () => {
    assert.deepEqual(parsePlayerParam(undefined), []);
    assert.deepEqual(parsePlayerParam(""), []);
  });

  test("splits, trims, drops blanks and keeps order", () => {
    assert.deepEqual(parsePlayerParam(" a , b ,, c "), ["a", "b", "c"]);
  });

  test("de-dupes while preserving first position", () => {
    assert.deepEqual(parsePlayerParam("a,b,a,c"), ["a", "b", "c"]);
  });

  test(`caps at ${MAX_COMPARE}`, () => {
    assert.deepEqual(parsePlayerParam("a,b,c,d,e"), ["a", "b", "c"]);
  });
});
