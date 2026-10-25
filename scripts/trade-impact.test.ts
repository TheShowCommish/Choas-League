/**
 * Trade impact preview (T-073).
 *
 *   npm test
 *
 * teamImpact / tradeImpact turn each side's roster -- season average per
 * player -- plus the players moving each way into a before/after best
 * starting-lineup total and a post-trade legality check. The contract these
 * fixtures pin:
 *
 *   - a straight 1-for-1 upgrade raises the receiver's after-total (and drops
 *     the giver's), the total being the best lineup autoFill would field;
 *   - a swap that leaves a side over a position limit is flagged illegal;
 *   - an empty / no-op trade leaves both totals and legality unchanged.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  teamImpact,
  tradeImpact,
  type ImpactSlot,
  type TradePlayer,
} from "../src/lib/trade-impact.ts";

/** One QB, two RB and one WR start; two bench spots behind them. */
const SLOTS: ImpactSlot[] = [
  { slot_key: "QB", label: "QB", count: 1, is_starter: true, eligible_positions: ["QB"] },
  { slot_key: "RB", label: "RB", count: 2, is_starter: true, eligible_positions: ["RB"] },
  { slot_key: "WR", label: "WR", count: 1, is_starter: true, eligible_positions: ["WR"] },
  { slot_key: "BN", label: "Bench", count: 2, is_starter: false, eligible_positions: [] },
];

function player(
  playerId: string,
  position: string,
  avg: number,
  projection: number | null = null,
): TradePlayer {
  return { playerId, position, avg, projection };
}

describe("teamImpact", () => {
  test("a 1-for-1 upgrade raises the after-total by the gap", () => {
    const roster = [
      player("qb", "QB", 18),
      player("rb1", "RB", 12),
      player("rb2", "RB", 9),
      player("wr1", "WR", 8),
    ];
    // Starters: everyone (one bench empty). before = 18+12+9+8 = 47.
    const impact = teamImpact(
      { roster, outgoing: ["rb2"], incoming: [player("rb3", "RB", 15)] },
      SLOTS,
      {},
    );

    assert.equal(impact.before, 47);
    assert.equal(impact.after, 53); // rb2 (9) -> rb3 (15)
    assert.equal(impact.delta, 6);
    assert.equal(impact.legality.legal, true);
  });

  test("best lineup, not every player: a benched upgrade still lifts the total", () => {
    // Two RB start; the weakest of three sits. Swapping the bench RB for a
    // better one lifts the starting total even though he was not starting.
    const roster = [
      player("qb", "QB", 18),
      player("rb1", "RB", 14),
      player("rb2", "RB", 11),
      player("rb3", "RB", 6), // benched: 3rd best RB, only two start
      player("wr1", "WR", 8),
    ];
    // before starters: QB18 + RB14 + RB11 + WR8 = 51 (rb3 benched).
    const impact = teamImpact(
      { roster, outgoing: ["rb3"], incoming: [player("rb4", "RB", 13)] },
      SLOTS,
      {},
    );
    assert.equal(impact.before, 51);
    assert.equal(impact.after, 53); // rb4 (13) now starts over rb2 (11)
    assert.equal(impact.delta, 2);
  });

  test("a swap that busts a position limit is flagged illegal", () => {
    const roster = [
      player("qb", "QB", 18),
      player("rb1", "RB", 12),
      player("rb2", "RB", 9),
    ];
    // Receive two more RBs for the QB: 4 RB held, limit is 3.
    const impact = teamImpact(
      {
        roster,
        outgoing: ["qb"],
        incoming: [player("rb3", "RB", 10), player("rb4", "RB", 7)],
      },
      SLOTS,
      { RB: 3 },
    );

    assert.equal(impact.legality.legal, false);
    assert.deepEqual(impact.legality.positionOver, [
      { position: "RB", count: 4, max: 3 },
    ]);
  });

  test("more players than the roster holds is over capacity", () => {
    // Capacity is 6 (1+2+1+2). Receive 3 for 1 -> 8 players.
    const roster = [
      player("qb", "QB", 18),
      player("rb1", "RB", 12),
      player("rb2", "RB", 9),
      player("wr1", "WR", 8),
      player("wr2", "WR", 7),
      player("te1", "TE", 5),
    ];
    const impact = teamImpact(
      {
        roster,
        outgoing: ["te1"],
        incoming: [
          player("wr3", "WR", 6),
          player("wr4", "WR", 6),
          player("wr5", "WR", 6),
        ],
      },
      SLOTS,
      {},
    );
    assert.equal(impact.legality.rosterSize, 8);
    assert.equal(impact.legality.rosterCapacity, 6);
    assert.equal(impact.legality.overCapacity, true);
    assert.equal(impact.legality.legal, false);
  });

  test("an empty / no-op trade leaves the total and legality unchanged", () => {
    const roster = [
      player("qb", "QB", 18),
      player("rb1", "RB", 12),
      player("rb2", "RB", 9),
      player("wr1", "WR", 8),
    ];
    const impact = teamImpact(
      { roster, outgoing: [], incoming: [] },
      SLOTS,
      { RB: 3 },
    );
    assert.equal(impact.before, impact.after);
    assert.equal(impact.delta, 0);
    assert.equal(impact.legality.legal, true);
  });
});

describe("tradeImpact", () => {
  test("one side's upgrade is the other side's downgrade", () => {
    const proposingRoster = [
      player("A-qb", "QB", 18),
      player("A-rb1", "RB", 14),
      player("A-rb2", "RB", 9),
      player("A-wr1", "WR", 8),
    ];
    const receivingRoster = [
      player("B-qb", "QB", 16),
      player("B-rb1", "RB", 15),
      player("B-rb2", "RB", 7),
      player("B-wr1", "WR", 10),
    ];

    // A gives rb2 (9), gets B's rb1 (15): an upgrade for A.
    const impact = tradeImpact(
      {
        roster: proposingRoster,
        outgoing: ["A-rb2"],
        incoming: [player("B-rb1", "RB", 15)],
      },
      {
        roster: receivingRoster,
        outgoing: ["B-rb1"],
        incoming: [player("A-rb2", "RB", 9)],
      },
      SLOTS,
      {},
    );

    assert.ok(impact.proposing.delta > 0, "proposing team's lineup improves");
    assert.ok(impact.receiving.delta < 0, "receiving team's lineup worsens");
    assert.equal(impact.proposing.delta, 6); // 9 -> 15
    assert.equal(impact.receiving.delta, -6); // 15 -> 9
  });
});
