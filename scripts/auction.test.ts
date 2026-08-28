/**
 * Functional tests for the auction draft.
 *
 * The budget rules are where an auction goes wrong: a team that spends
 * everything on one player and cannot fill its roster ruins the draft
 * for everyone, so the cap on each bid is the thing worth proving.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, type TestDb } from "./lib/test-db.ts";
import { buildLeague, makePlayer, ownerOf, type Fixture } from "./lib/fixtures.ts";

let db: TestDb;

interface AuctionFixture extends Fixture {
  draftId: string;
}

/**
 * A live auction with a small budget and roster, so the arithmetic in
 * the assertions stays readable.
 */
async function liveAuction(
  name: string,
  budget = 100,
  rounds = 3,
): Promise<AuctionFixture> {
  const f = await buildLeague(db, name);
  await db.actAs(f.commish);

  await db.q("update public.leagues set draft_type = 'auction' where id = $1", [
    f.leagueId,
  ]);

  const created = await db.one<{ generate_draft: string }>(
    "select public.generate_draft($1) as generate_draft",
    [f.leagueId],
  );
  const draftId = created.generate_draft;

  await db.q(
    `update public.drafts
       set type = 'auction', rounds = $2, auction_budget = $3
     where id = $1`,
    [draftId, rounds, budget],
  );

  // Regenerate now the type is auction, so no snake board is left over.
  await db.q("select public.generate_draft($1, false)", [f.leagueId]);
  await db.q("update public.drafts set status = 'live' where id = $1", [draftId]);

  return { ...f, draftId };
}

/** Nominate as whoever is up, and return the new lot id. */
async function nominate(
  f: AuctionFixture,
  playerId: string,
  openingBid = 1,
): Promise<{ lotId: string; teamId: string }> {
  const { auction_nominator: teamId } = await db.one<{
    auction_nominator: string;
  }>("select public.auction_nominator($1) as auction_nominator", [f.draftId]);

  await db.actAs(await ownerOf(db, teamId));

  const lot = await db.one<{ nominate_player: string }>(
    "select public.nominate_player($1, $2, $3) as nominate_player",
    [f.draftId, playerId, openingBid],
  );

  return { lotId: lot.nominate_player, teamId };
}

/** Run the clock out on a lot and award it. */
async function closeLot(lotId: string): Promise<string | null> {
  await db.q(
    "update public.auction_lots set closes_at = now() - interval '1 second' where id = $1",
    [lotId],
  );
  const result = await db.one<{ close_auction_lot: string | null }>(
    "select public.close_auction_lot($1) as close_auction_lot",
    [lotId],
  );
  return result.close_auction_lot;
}

before(async () => {
  db = await createTestDb();
});

after(async () => {
  await db.close();
});

describe("auction draft", () => {
  test("an auction generates no pre-built board", async () => {
    const f = await liveAuction("auction-board");

    const picks = await db.q(
      "select 1 from public.draft_picks where draft_id = $1",
      [f.draftId],
    );
    assert.equal(picks.length, 0, "picks appear as lots are won, not upfront");

    const order = await db.q(
      "select 1 from public.draft_order where draft_id = $1",
      [f.draftId],
    );
    assert.equal(order.length, 4, "but the nomination order still exists");
  });

  test("the high bidder wins the player and is charged the bid", async () => {
    const f = await liveAuction("auction-win");
    const pid = await makePlayer(db, "AUC_WR", "Auction Receiver", "WR");

    const { lotId, teamId: nominator } = await nominate(f, pid, 1);

    const rival = f.teamIds.find((id) => id !== nominator)!;
    await db.actAs(await ownerOf(db, rival));
    await db.q("select public.place_bid($1, $2, 25)", [lotId, rival]);

    assert.equal(await closeLot(lotId), rival);

    const roster = await db.q(
      "select 1 from public.roster_players where team_id = $1 and player_id = $2",
      [rival, pid],
    );
    assert.equal(roster.length, 1, "the winner gets the player");

    const left = await db.one<{ auction_budget_left: number }>(
      "select public.auction_budget_left($1, $2) as auction_budget_left",
      [f.draftId, rival],
    );
    assert.equal(left.auction_budget_left, 75, "100 - 25");

    const loser = await db.one<{ auction_budget_left: number }>(
      "select public.auction_budget_left($1, $2) as auction_budget_left",
      [f.draftId, nominator],
    );
    assert.equal(loser.auction_budget_left, 100, "losing bids cost nothing");
  });

  test("a bid at or below the standing high bid is rejected", async () => {
    const f = await liveAuction("auction-lowball");
    const pid = await makePlayer(db, "AUC_LOW", "Lowball Target", "RB");

    const { lotId, teamId: nominator } = await nominate(f, pid, 10);

    const rival = f.teamIds.find((id) => id !== nominator)!;
    await db.actAs(await ownerOf(db, rival));

    await assert.rejects(
      () => db.q("select public.place_bid($1, $2, 10)", [lotId, rival]),
      /already \$10/,
    );
    await assert.rejects(
      () => db.q("select public.place_bid($1, $2, 4)", [lotId, rival]),
      /already \$10/,
    );
  });

  test("you cannot bid so much that you could not fill your roster", async () => {
    // Three roster spots and $100: a bid must leave $1 for each empty one.
    const f = await liveAuction("auction-budget", 100, 3);
    const pid = await makePlayer(db, "AUC_MAX", "Max Bid Target", "WR");

    const { auction_nominator: nominator } = await db.one<{
      auction_nominator: string;
    }>("select public.auction_nominator($1) as auction_nominator", [f.draftId]);

    const max = await db.one<{ auction_max_bid: number }>(
      "select public.auction_max_bid($1, $2) as auction_max_bid",
      [f.draftId, nominator],
    );
    assert.equal(max.auction_max_bid, 98, "$100 less $1 for each of the other two slots");

    await db.actAs(await ownerOf(db, nominator));

    await assert.rejects(
      () => db.q("select public.nominate_player($1, $2, 99)", [f.draftId, pid]),
      /unable to fill your roster/,
    );

    // The maximum itself is allowed.
    await db.q("select public.nominate_player($1, $2, 98)", [f.draftId, pid]);
  });

  test("the bid cap tightens as a roster fills", async () => {
    const f = await liveAuction("auction-cap", 100, 3);

    const first = await makePlayer(db, "CAP_A", "Cap One", "WR");
    const { lotId, teamId } = await nominate(f, first, 10);
    assert.equal(await closeLot(lotId), teamId);

    // $90 left, one slot still to fill after the next: cap is $89.
    const max = await db.one<{ auction_max_bid: number }>(
      "select public.auction_max_bid($1, $2) as auction_max_bid",
      [f.draftId, teamId],
    );
    assert.equal(max.auction_max_bid, 89);
  });

  test("nomination rotates through the draft order", async () => {
    const f = await liveAuction("auction-rotation");

    const order = await db.q<{ team_id: string }>(
      "select team_id from public.draft_order where draft_id = $1 order by position",
      [f.draftId],
    );

    for (let i = 0; i < 5; i++) {
      const pid = await makePlayer(db, `ROT_${i}`, `Rotation ${i}`, "WR");
      const { lotId, teamId } = await nominate(f, pid, 1);

      assert.equal(
        teamId,
        order[i % order.length].team_id,
        `nomination ${i + 1} should belong to team ${(i % order.length) + 1}`,
      );

      await closeLot(lotId);
    }
  });

  test("only one lot is open at a time", async () => {
    const f = await liveAuction("auction-onelot");
    const a = await makePlayer(db, "AUC_A", "First Up", "WR");
    const b = await makePlayer(db, "AUC_B", "Second Up", "WR");

    await nominate(f, a, 1);

    await assert.rejects(
      () => db.q("select public.nominate_player($1, $2, 1)", [f.draftId, b]),
      /already a player up for bid/,
    );
  });

  test("a player already drafted cannot be nominated again", async () => {
    const f = await liveAuction("auction-dupe");
    const pid = await makePlayer(db, "AUC_DUPE", "Twice Nominated", "TE");

    const { lotId } = await nominate(f, pid, 1);
    await closeLot(lotId);

    // Nomination has rotated on, so act as whoever is up now -- the turn
    // check runs before the availability check, as authorisation should.
    const { auction_nominator: next } = await db.one<{
      auction_nominator: string;
    }>("select public.auction_nominator($1) as auction_nominator", [f.draftId]);
    await db.actAs(await ownerOf(db, next));

    await assert.rejects(
      () => db.q("select public.nominate_player($1, $2, 1)", [f.draftId, pid]),
      /already been drafted/,
    );
  });

  test("closing before the clock expires does nothing", async () => {
    const f = await liveAuction("auction-early");
    const pid = await makePlayer(db, "AUC_EARLY", "Early Close", "TE");

    const { lotId } = await nominate(f, pid, 5);

    const result = await db.one<{ close_auction_lot: string | null }>(
      "select public.close_auction_lot($1) as close_auction_lot",
      [lotId],
    );
    assert.equal(result.close_auction_lot, null, "the clock has not run out");

    const still = await db.one<{ status: string }>(
      "select status from public.auction_lots where id = $1",
      [lotId],
    );
    assert.equal(still.status, "open");
  });

  test("a bid resets the clock", async () => {
    const f = await liveAuction("auction-clock");
    const pid = await makePlayer(db, "AUC_CLOCK", "Clock Reset", "WR");

    const { lotId, teamId: nominator } = await nominate(f, pid, 1);

    // Wind the clock down to almost nothing, then bid.
    await db.q(
      "update public.auction_lots set closes_at = now() + interval '1 second' where id = $1",
      [lotId],
    );

    const rival = f.teamIds.find((id) => id !== nominator)!;
    await db.actAs(await ownerOf(db, rival));
    await db.q("select public.place_bid($1, $2, 5)", [lotId, rival]);

    const lot = await db.one<{ extended: boolean }>(
      "select closes_at > now() + interval '5 seconds' as extended " +
        "from public.auction_lots where id = $1",
      [lotId],
    );
    assert.equal(lot.extended, true, "a late bid must not sneak through");
  });

  test("the draft completes once every roster is full", async () => {
    // One round and four teams, so four lots fills everybody.
    const f = await liveAuction("auction-end", 100, 1);

    for (let i = 0; i < 4; i++) {
      const pid = await makePlayer(db, `END_AUC_${i}`, `Auction End ${i}`, "WR");
      const { lotId } = await nominate(f, pid, 1);
      await closeLot(lotId);
    }

    const draft = await db.one<{ status: string }>(
      "select status from public.drafts where id = $1",
      [f.draftId],
    );
    assert.equal(draft.status, "complete");

    const leagueRow = await db.one<{ status: string }>(
      "select status from public.leagues where id = $1",
      [f.leagueId],
    );
    assert.equal(leagueRow.status, "in_season");
  });
});
