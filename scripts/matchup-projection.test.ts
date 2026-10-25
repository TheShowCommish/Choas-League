/**
 * Live matchup projection (T-071).
 *
 *   npm test
 *
 * projectSide / projectMatchup turn each side's starters -- actual points,
 * weekly projection, game status -- into a projected final, a yet-to-play
 * count and the projection still owed. The contract these fixtures pin:
 *
 *   - a final game is locked at its actual points; anything else uses the
 *     projection, so the projected final tracks the game as it is played;
 *   - once every game is final the projected final equals the real final
 *     (every starter contributes actual, remaining and yet-to-play are 0);
 *   - "yet to play" counts only starters who have not kicked off;
 *   - a bye / empty starter contributes its (zero) projection and is not
 *     counted as yet to play.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  projectSide,
  projectMatchup,
  type StarterProjectionInput,
} from "../src/lib/matchup-projection.ts";

/** A starter whose game is already final, scored `actual`. */
function final(actual: number, projected: number): StarterProjectionInput {
  return { actual, projected, status: "final" };
}

/** A starter mid-game: some actual on the board, projection still used. */
function live(actual: number, projected: number): StarterProjectionInput {
  return { actual, projected, status: "in_progress" };
}

/** A starter who has not kicked off. */
function scheduled(projected: number): StarterProjectionInput {
  return { actual: 0, projected, status: "scheduled" };
}

/** A starter on a bye: no game, no projection. */
function bye(): StarterProjectionInput {
  return { actual: 0, projected: 0, status: null };
}

describe("projectSide", () => {
  test("all games final: projected final equals the actual final", () => {
    const starters = [final(21.3, 18), final(9.4, 12), final(0, 7)];
    const side = projectSide(starters);

    const actualFinal = starters.reduce((s, p) => s + p.actual, 0);
    assert.equal(side.projFinal, Math.round(actualFinal * 100) / 100);
    assert.equal(side.yetToPlay, 0);
    assert.equal(side.remaining, 0);
  });

  test("mixed in-progress and scheduled: actual for final, projection for the rest", () => {
    const side = projectSide([
      final(20, 15), // locked at 20
      live(8, 14), // not final -> projection 14
      scheduled(10), // not final -> projection 10, yet to play
      scheduled(6), // not final -> projection 6, yet to play
    ]);

    assert.equal(side.projFinal, 20 + 14 + 10 + 6);
    assert.equal(side.yetToPlay, 2);
    assert.equal(side.remaining, 14 + 10 + 6);
  });

  test("a bye / empty starter adds nothing and is not counted yet to play", () => {
    const side = projectSide([final(12, 10), bye()]);

    assert.equal(side.projFinal, 12);
    assert.equal(side.yetToPlay, 0);
    assert.equal(side.remaining, 0);
  });

  test("an empty side is a clean zero", () => {
    assert.deepEqual(projectSide([]), {
      projFinal: 0,
      yetToPlay: 0,
      remaining: 0,
    });
  });

  test("fractional points do not drift", () => {
    const side = projectSide([scheduled(0.1), scheduled(0.2)]);
    assert.equal(side.projFinal, 0.3);
    assert.equal(side.remaining, 0.3);
  });
});

describe("projectMatchup", () => {
  test("margin is home projected final minus away, positive when home leads", () => {
    const m = projectMatchup(
      [final(50, 40), scheduled(20)], // home projFinal 70
      [final(45, 48), scheduled(15)], // away projFinal 60
    );
    assert.equal(m.home.projFinal, 70);
    assert.equal(m.away.projFinal, 60);
    assert.equal(m.margin, 10);
  });

  test("a bye week (no away side) returns a zeroed away half", () => {
    const m = projectMatchup([final(30, 25), scheduled(12)], null);
    assert.equal(m.home.projFinal, 42);
    assert.deepEqual(m.away, { projFinal: 0, yetToPlay: 0, remaining: 0 });
    assert.equal(m.margin, 42);
  });

  test("all final reconciles on both sides, margin matches the real result", () => {
    const m = projectMatchup(
      [final(60, 55), final(40, 42)],
      [final(70, 68), final(20, 25)],
    );
    assert.equal(m.home.projFinal, 100);
    assert.equal(m.away.projFinal, 90);
    assert.equal(m.margin, 10);
    assert.equal(m.home.remaining, 0);
    assert.equal(m.away.remaining, 0);
  });
});
