/**
 * Which weeks the scheduled stat sync pulls when it is not told.
 *
 * Getting this wrong is silent: the sync succeeds, just for the wrong
 * week, and the week that needed its official numbers never gets them
 * and so never finalizes.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { statWeeksToSync } from "../src/lib/ingest/stat-weeks.ts";

const schedule = [
  // Week 1: Thursday to Monday night.
  { week: 1, kickoff_at: "2026-09-11T00:20:00Z" },
  { week: 1, kickoff_at: "2026-09-15T00:15:00Z" },
  // Week 2.
  { week: 2, kickoff_at: "2026-09-18T00:15:00Z" },
  { week: 2, kickoff_at: "2026-09-22T00:15:00Z" },
  // Week 3, and a game with no kickoff time yet.
  { week: 3, kickoff_at: "2026-09-25T00:15:00Z" },
  { week: 3, kickoff_at: null },
];

describe("stat sync week selection", () => {
  test("before any kickoff there is nothing to pull", () => {
    assert.deepEqual(statWeeksToSync(schedule, new Date("2026-09-01T00:00:00Z")), []);
  });

  test("week 1 alone once it has started", () => {
    assert.deepEqual(statWeeksToSync(schedule, new Date("2026-09-14T12:00:00Z")), [1]);
  });

  test("the Tuesday after Monday night pulls that week and the one before", () => {
    assert.deepEqual(statWeeksToSync(schedule, new Date("2026-09-23T10:00:00Z")), [1, 2]);
  });

  test("once Thursday starts a new week, the previous week is still pulled", () => {
    assert.deepEqual(statWeeksToSync(schedule, new Date("2026-09-25T04:00:00Z")), [2, 3]);
  });

  test("a game with no kickoff time does not count as started", () => {
    assert.deepEqual(
      statWeeksToSync([{ week: 5, kickoff_at: null }], new Date("2026-12-01T00:00:00Z")),
      [],
    );
  });
});
