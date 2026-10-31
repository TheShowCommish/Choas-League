/**
 * Notification copy builders (T-072).
 *
 *   npm test
 *
 * These are the pure functions each event site uses to turn the names and
 * scores already in scope into the {type, title, body, link} that notify()
 * stores. The contract pinned here:
 *
 *   - every builder points at the right in-league screen;
 *   - a rejection names the other team to the proposer, a withdrawal names
 *     the proposer to the receiver;
 *   - a waiver win shows the bid only when there was one;
 *   - a finalized matchup reads from the recipient's point of view (win /
 *     loss / tie / bye), and scores drop a pointless trailing .0.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  matchupFinalNotification,
  tradeAcceptedNotification,
  tradeClosedNotification,
  tradeOfferNotification,
  waiverLostNotification,
  waiverWonNotification,
} from "../src/lib/notifications.ts";

const L = "league-1";

describe("trade notifications", () => {
  test("an offer tells the receiver who proposed it, linking to trades", () => {
    const n = tradeOfferNotification(L, "Alice FC");
    assert.equal(n.type, "trade_offer");
    assert.match(n.body, /Alice FC/);
    assert.equal(n.link, "/l/league-1/trades");
  });

  test("an acceptance tells the proposer who accepted", () => {
    const n = tradeAcceptedNotification(L, "Bob United");
    assert.equal(n.type, "trade_accepted");
    assert.match(n.body, /Bob United accepted/);
  });

  test("a rejection is addressed to the proposer", () => {
    const n = tradeClosedNotification(L, "rejected", "Bob United");
    assert.equal(n.type, "trade_rejected");
    assert.match(n.body, /Bob United rejected your trade/);
  });

  test("a withdrawal is addressed to the manager it was offered to", () => {
    const n = tradeClosedNotification(L, "withdrawn", "Alice FC");
    assert.equal(n.type, "trade_withdrawn");
    assert.match(n.body, /Alice FC withdrew/);
  });
});

describe("waiver notifications", () => {
  test("a win shows the winning bid when there was one", () => {
    const n = waiverWonNotification(L, "Jones", 17);
    assert.equal(n.type, "waiver_won");
    assert.match(n.body, /Jones for \$17/);
    assert.equal(n.link, "/l/league-1/transactions");
  });

  test("a win hides the bid in a priority league (null / zero)", () => {
    assert.doesNotMatch(waiverWonNotification(L, "Jones", null).body, /\$/);
    assert.doesNotMatch(waiverWonNotification(L, "Jones", 0).body, /\$/);
  });

  test("a loss carries the result note as the reason", () => {
    const n = waiverLostNotification(L, "Jones", "Outbid");
    assert.equal(n.type, "waiver_lost");
    assert.match(n.body, /Jones/);
    assert.match(n.body, /\(Outbid\)/);
  });

  test("a loss with no note still reads cleanly", () => {
    const n = waiverLostNotification(L, "Jones", "");
    assert.doesNotMatch(n.body, /\(\)/);
  });
});

describe("matchup final notifications", () => {
  test("a win reads from the recipient's point of view", () => {
    const n = matchupFinalNotification(L, 5, 112.4, 98.1, "Bob United");
    assert.equal(n.type, "matchup_final");
    assert.equal(n.title, "Week 5 final: W vs Bob United");
    assert.match(n.body, /You beat Bob United 112.4-98.1/);
    assert.equal(n.link, "/l/league-1/matchups");
  });

  test("a loss flips the title and the verb", () => {
    const n = matchupFinalNotification(L, 5, 98.1, 112.4, "Bob United");
    assert.equal(n.title, "Week 5 final: L vs Bob United");
    assert.match(n.body, /You lost to Bob United/);
  });

  test("a tie is its own outcome", () => {
    const n = matchupFinalNotification(L, 5, 100, 100, "Bob United");
    assert.equal(n.title, "Week 5 final: T vs Bob United");
    assert.match(n.body, /You tied Bob United 100-100/);
  });

  test("a bye has no opponent", () => {
    const n = matchupFinalNotification(L, 5, 120.5, 0, null);
    assert.equal(n.title, "Week 5 final: Bye");
    assert.match(n.body, /Week 5 is final \(120.5\)/);
  });

  test("whole-number scores drop the trailing .0", () => {
    const n = matchupFinalNotification(L, 1, 120, 90, "X");
    assert.match(n.body, /120-90/);
  });
});
