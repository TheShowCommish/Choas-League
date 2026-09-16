/**
 * The small pure helpers the UI is built on: what order positions come
 * in, what they are called, which crest a club gets, and what happens to
 * a colour somebody typed in by hand.
 *
 *   npm test
 *
 * None of these touch a database. They are here because each one is a
 * single source of truth that a dozen components read from, and the
 * whole point of consolidating them was that the copies had drifted.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  POSITION_ORDER,
  byPosition,
  positionLabel,
  positionRank,
  sortPositions,
} from "../src/lib/roster-slots.ts";
import { isKnownNflTeam, nflLogoUrl } from "../src/lib/nfl-teams.ts";
import { safeColor, tint } from "../src/lib/colors.ts";

describe("position order", () => {
  test("is the order a lineup card reads in", () => {
    // The order asked for, and the order every menu in the app shows.
    const asked = ["QB", "RB", "WR", "TE", "FLEX", "DEF", "K", "P", "HC"];

    assert.deepEqual(
      POSITION_ORDER.filter((p) => asked.includes(p)),
      asked,
      "POSITION_ORDER puts the fantasy positions in the wrong order",
    );
  });

  test("sorts a menu whatever order it arrives in", () => {
    // Alphabetical is what the database hands back.
    const fromDatabase = ["DEF", "HC", "K", "P", "QB", "RB", "TE", "WR"];

    assert.deepEqual(sortPositions([...fromDatabase, "FLEX"]), [
      "QB",
      "RB",
      "WR",
      "TE",
      "FLEX",
      "DEF",
      "K",
      "P",
      "HC",
    ]);
  });

  test("an unknown position sorts last, not first", () => {
    assert.deepEqual(sortPositions(["LS", "QB", "WR"]), ["QB", "WR", "LS"]);
    assert.ok(positionRank("LS") > positionRank("HC"));
  });

  test("unknowns are ordered among themselves alphabetically", () => {
    assert.deepEqual(sortPositions(["NT", "LS", "QB"]), ["QB", "LS", "NT"]);
    assert.ok(byPosition("LS", "NT") < 0);
  });

  test("a defence is called a D/ST, and everything else is itself", () => {
    assert.equal(positionLabel("DEF"), "D/ST");
    assert.equal(positionLabel("QB"), "QB");
    assert.equal(positionLabel(null), "?");
  });
});

describe("NFL crests", () => {
  test("every club in the seed has a logo", () => {
    // The abbreviations 0015_seed_nfl_teams.sql inserts.
    const clubs = [
      "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN",
      "DET", "GB", "HOU", "IND", "JAX", "KC", "LA", "LAC", "LV", "MIA",
      "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SEA", "SF", "TB",
      "TEN", "WAS",
    ];

    for (const abbr of clubs) {
      assert.ok(isKnownNflTeam(abbr), `${abbr} has no crest`);
    }
  });

  test("the three abbreviations that differ from ESPN's still resolve", () => {
    // These are the ones that would silently show a broken image.
    assert.match(nflLogoUrl("LA")!, /\/lar\.png$/);
    assert.match(nflLogoUrl("WAS")!, /\/wsh\.png$/);
    assert.match(nflLogoUrl("LV")!, /\/lv\.png$/);
  });

  test("a player with no club has no crest to draw", () => {
    assert.equal(nflLogoUrl(null), null);
    assert.equal(nflLogoUrl(""), null);
    assert.equal(nflLogoUrl("NOPE"), null);
  });
});

describe("team colours", () => {
  test("a hex colour passes through", () => {
    assert.equal(safeColor("#1971c2"), "#1971c2");
    assert.equal(safeColor("  #fff  "), "#fff");
  });

  test("anything that is not one is replaced", () => {
    // These reach a style attribute and a stylesheet, so a value that
    // closes the rule it is in must never survive.
    assert.equal(safeColor("red; } body { display: none"), "#4f8ef7");
    assert.equal(safeColor("url(evil)"), "#4f8ef7");
    assert.equal(safeColor(null), "#4f8ef7");
    assert.equal(safeColor(""), "#4f8ef7");
  });

  test("a tint is that colour, safely, at a strength", () => {
    assert.equal(tint("#1971c2", 20), "color-mix(in srgb, #1971c2 20%, transparent)");
    assert.ok(!tint("}evil{", 20).includes("evil"));
  });
});
