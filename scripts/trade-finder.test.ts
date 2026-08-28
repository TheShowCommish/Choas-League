/**
 * The trade finder's matching rules.
 *
 * Pure arithmetic, so these run without a database.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  findTrades,
  imbalanceOf,
  type ValuedPlayer,
} from "../src/lib/trade-finder.ts";

function player(
  playerId: string,
  value: number,
  ownerTeamId: string,
  onBlock = false,
): ValuedPlayer {
  return {
    playerId,
    fullName: playerId,
    position: "RB",
    teamAbbr: "KC",
    ownerTeamId,
    onBlock,
    games: 5,
    avgPoints: value / 10,
    value,
  };
}

describe("trade finder", () => {
  test("imbalance is measured against the bigger side", () => {
    assert.equal(imbalanceOf(100, 100), 0);
    assert.equal(imbalanceOf(100, 90), 0.1);
    // Same gap, but now the bigger side is what you receive.
    assert.equal(imbalanceOf(90, 100), 0.1);
    assert.equal(imbalanceOf(0, 0), 0);
  });

  test("a tighter tolerance returns fewer, fairer deals", () => {
    const give = [player("mine", 100, "me")];
    const pool = [
      player("dead-on", 100, "them"),
      player("close", 92, "them"),
      player("loose", 70, "them"),
    ];

    const tight = findTrades(give, pool, { tolerance: 0.05, maxIncoming: 1 });
    assert.deepEqual(
      tight.map((t) => t.receive[0].playerId),
      ["dead-on"],
    );

    const loose = findTrades(give, pool, { tolerance: 0.35, maxIncoming: 1 });
    assert.deepEqual(
      loose.map((t) => t.receive[0].playerId),
      ["dead-on", "close", "loose"],
      "fairest first",
    );
  });

  test("a package can only come from one team", () => {
    const give = [player("mine", 100, "me")];
    const pool = [
      player("a", 50, "team-a"),
      player("b", 50, "team-b"),
    ];

    // 50 + 50 would be a perfect match, but they belong to two managers.
    const found = findTrades(give, pool, { tolerance: 0.05, maxIncoming: 2 });
    assert.equal(found.length, 0);
  });

  test("two players can come back for one", () => {
    const give = [player("star", 100, "me")];
    const pool = [
      player("half-a", 52, "them"),
      player("half-b", 50, "them"),
    ];

    const found = findTrades(give, pool, { tolerance: 0.05, maxIncoming: 2 });
    assert.equal(found.length, 1);
    assert.deepEqual(
      found[0].receive.map((p) => p.playerId).sort(),
      ["half-a", "half-b"],
    );
    assert.equal(found[0].receiveValue, 102);
    assert.equal(found[0].difference, 2);
  });

  test("your own players are never offered back to you", () => {
    const mine = player("mine", 100, "me");
    const found = findTrades([mine], [mine, player("theirs", 100, "them")], {
      tolerance: 0.05,
    });
    assert.deepEqual(
      found.map((t) => t.receive[0].playerId),
      ["theirs"],
    );
  });

  test("blockOnly considers only players put up for trade", () => {
    const give = [player("mine", 100, "me")];
    const pool = [
      player("listed", 100, "them", true),
      player("not-listed", 100, "them", false),
    ];

    const found = findTrades(give, pool, {
      tolerance: 0.05,
      maxIncoming: 1,
      blockOnly: true,
    });
    assert.deepEqual(
      found.map((t) => t.receive[0].playerId),
      ["listed"],
    );
  });

  test("offering nobody finds nothing", () => {
    assert.deepEqual(findTrades([], [player("a", 10, "them")]), []);
  });
});
