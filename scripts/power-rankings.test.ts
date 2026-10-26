/**
 * Power rankings (T-078).
 *
 *   npm test
 *
 * powerRankings blends season PF, recent form and all-play win% into a per-
 * team score and ranks the field. The contract these fixtures pin:
 *
 *   - more season points ranks higher, all else equal;
 *   - a hot recent run lifts a team above an equal-PF rival that has cooled;
 *   - all-play win% rewards a team that would beat most of the field weekly;
 *   - ties on score break deterministically by season PF then team id;
 *   - a team with no games is handled (scores 0, ranks last) without throwing;
 *   - ranks are always 1..N contiguous, best first.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  powerRankings,
  type PowerTeamInput,
  type TeamWeekScore,
} from "../src/lib/power-rankings.ts";

/** Build season aggregates from a team id and its per-week scores. */
function team(teamId: string, weekly: number[]): {
  input: PowerTeamInput;
  scores: TeamWeekScore[];
} {
  return {
    input: {
      teamId,
      pointsFor: weekly.reduce((a, b) => a + b, 0),
      gamesPlayed: weekly.length,
    },
    scores: weekly.map((points, i) => ({ teamId, week: i + 1, points })),
  };
}

function rankOf(entries: ReturnType<typeof powerRankings>, teamId: string) {
  const e = entries.find((x) => x.teamId === teamId);
  assert.ok(e, `expected an entry for ${teamId}`);
  return e.rank;
}

describe("powerRankings", () => {
  test("more season points ranks higher, all else equal", () => {
    const a = team("a", [100, 100, 100]);
    const b = team("b", [90, 90, 90]);
    const c = team("c", [80, 80, 80]);
    const entries = powerRankings(
      [a.input, b.input, c.input],
      [...a.scores, ...b.scores, ...c.scores],
    );
    assert.equal(rankOf(entries, "a"), 1);
    assert.equal(rankOf(entries, "b"), 2);
    assert.equal(rankOf(entries, "c"), 3);
  });

  test("recent form shifts a team up vs an equal-total rival", () => {
    // Five weeks whose scores are a mirror image between the two teams, so
    // season PF (500 each) and all-play win% (2.5/5 each) are identical: the
    // only thing left to separate them is recent form. "hot" lost early and
    // won the last two; the 3-week window (weeks 3-5) favours it.
    const hot = team("hot", [80, 80, 120, 120, 100]);
    const cold = team("cold", [120, 120, 80, 80, 100]);
    const entries = powerRankings(
      [hot.input, cold.input],
      [...hot.scores, ...cold.scores],
    );
    assert.equal(hot.input.pointsFor, cold.input.pointsFor);
    assert.equal(rankOf(entries, "hot"), 1);
    assert.equal(rankOf(entries, "cold"), 2);
  });

  test("all-play win% rewards beating the field", () => {
    // Three teams, three weeks. "boss" outscores both others every week, so it
    // has a perfect all-play record as well as the most points.
    const boss = team("boss", [110, 110, 110]);
    const mid = team("mid", [100, 100, 100]);
    const low = team("low", [90, 90, 90]);
    const entries = powerRankings(
      [boss.input, mid.input, low.input],
      [...boss.scores, ...mid.scores, ...low.scores],
    );
    assert.equal(rankOf(entries, "boss"), 1);
    const bossEntry = entries.find((e) => e.teamId === "boss");
    assert.equal(bossEntry?.allPlayWinPct, 1);
    const lowEntry = entries.find((e) => e.teamId === "low");
    assert.equal(lowEntry?.allPlayWinPct, 0);
  });

  test("identical teams tie-break by team id ascending", () => {
    const x = team("x", [100, 100]);
    const y = team("y", [100, 100]);
    const entries = powerRankings(
      [y.input, x.input],
      [...x.scores, ...y.scores],
    );
    // Equal score and equal PF -> team id breaks it, "x" before "y".
    assert.equal(rankOf(entries, "x"), 1);
    assert.equal(rankOf(entries, "y"), 2);
  });

  test("a team with no games is handled and ranks last", () => {
    const played = team("played", [100, 100, 100]);
    const idle: PowerTeamInput = {
      teamId: "idle",
      pointsFor: 0,
      gamesPlayed: 0,
    };
    const entries = powerRankings([played.input, idle], played.scores);
    assert.equal(rankOf(entries, "played"), 1);
    const idleEntry = entries.find((e) => e.teamId === "idle");
    assert.equal(idleEntry?.powerScore, 0);
    assert.equal(idleEntry?.recentForm, 0);
    assert.equal(idleEntry?.allPlayWinPct, 0);
    assert.equal(rankOf(entries, "idle"), 2);
  });

  test("ranks are 1..N contiguous, best first", () => {
    const ts = [
      team("a", [95, 88, 102]),
      team("b", [110, 70, 90]),
      team("c", [60, 60, 60]),
      team("d", [100, 100, 100]),
    ];
    const entries = powerRankings(
      ts.map((t) => t.input),
      ts.flatMap((t) => t.scores),
    );
    const ranks = entries.map((e) => e.rank).sort((x, y) => x - y);
    assert.deepEqual(ranks, [1, 2, 3, 4]);
    // Sorted best-first: scores must be non-increasing down the list.
    for (let i = 1; i < entries.length; i++) {
      assert.ok(entries[i - 1].powerScore >= entries[i].powerScore);
    }
  });

  test("no games at all: everyone scores 0, ranks still 1..N", () => {
    const entries = powerRankings(
      [
        { teamId: "a", pointsFor: 0, gamesPlayed: 0 },
        { teamId: "b", pointsFor: 0, gamesPlayed: 0 },
      ],
      [],
    );
    assert.deepEqual(
      entries.map((e) => e.powerScore),
      [0, 0],
    );
    assert.deepEqual(
      entries.map((e) => e.rank),
      [1, 2],
    );
  });
});
