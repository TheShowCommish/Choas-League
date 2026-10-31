/**
 * Watchlist availability helpers (T-074).
 *
 *   npm test
 *
 * The pure logic behind each watchlist row's "where can I get him" chip:
 * owned beats waivers beats free agent, and the label names the owner when
 * there is one.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  watchAvailability,
  watchAvailabilityLabel,
} from "../src/lib/watchlist.ts";

describe("watchAvailability", () => {
  test("an owner means owned, whatever the waiver flag says", () => {
    assert.equal(watchAvailability("Alice FC", false), "owned");
    assert.equal(watchAvailability("Alice FC", true), "owned");
  });

  test("no owner but on waivers means waivers", () => {
    assert.equal(watchAvailability(null, true), "waivers");
  });

  test("no owner and not on waivers means free agent", () => {
    assert.equal(watchAvailability(null, false), "fa");
  });
});

describe("watchAvailabilityLabel", () => {
  test("owned names the rostering team", () => {
    assert.equal(
      watchAvailabilityLabel("owned", "Alice FC"),
      "Rostered by Alice FC",
    );
  });

  test("owned without a resolved name still reads cleanly", () => {
    assert.equal(watchAvailabilityLabel("owned", null), "Rostered");
  });

  test("waivers and free agent read plainly", () => {
    assert.equal(watchAvailabilityLabel("waivers", null), "On waivers");
    assert.equal(watchAvailabilityLabel("fa", null), "Free agent");
  });
});
