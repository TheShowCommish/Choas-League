/**
 * The draft board ships a thinned player pool (T-087).
 *
 *   npm test
 *
 * `league_player_pool` returns two dozen columns; the draft room renders
 * eleven of them. `toDraftablePlayer` is the projection that keeps the
 * payload to the browser from carrying the other thirteen for every one
 * of the 500 pooled players. These pin that it keeps what the room reads
 * and drops everything else -- a cast (the old behaviour) would silently
 * keep the lot.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  DRAFT_POOL_RENDER_LIMIT,
  toDraftablePlayer,
  type PoolRpcRow,
} from "../src/lib/draft-pool.ts";

/** A row shaped like the RPC's full output, heavy columns and all. */
function rpcRow(overrides: Partial<PoolRpcRow> = {}): PoolRpcRow {
  return {
    player_id: "00-0036223",
    full_name: "Pool Player",
    pos: "WR",
    team_abbr: "KC",
    total_points: 123.4,
    adp: 12.5,
    adp_rank: 13,
    proj_points: 200.1,
    injury_status: null,
    injury_body_part: null,
    bye_week: 10,
    // The columns the board never reads and must not be shipped.
    status: "ACT",
    headshot_url: "https://example.test/x.png",
    owner_team_id: "team-uuid",
    owner_team_name: "Somebody Else",
    on_waivers: false,
    waiver_clears_at: null,
    avg_points: 7.2,
    games: 17,
    last_points: 9.9,
    next_opponent: "DEN",
    next_kickoff: "2027-09-10T00:00:00Z",
    next_is_home: true,
    total_count: 2700,
    ...overrides,
  };
}

describe("toDraftablePlayer", () => {
  test("keeps exactly the eleven fields the board renders", () => {
    const slim = toDraftablePlayer(rpcRow());
    assert.deepEqual(
      Object.keys(slim).sort(),
      [
        "adp",
        "adp_rank",
        "bye_week",
        "full_name",
        "injury_body_part",
        "injury_status",
        "player_id",
        "pos",
        "proj_points",
        "team_abbr",
        "total_points",
      ],
      "the slim shape is only what the draft room reads",
    );
  });

  test("drops the heavy columns the Players tab needs but the board does not", () => {
    const slim = toDraftablePlayer(rpcRow()) as unknown as Record<
      string,
      unknown
    >;
    for (const gone of [
      "headshot_url",
      "owner_team_id",
      "owner_team_name",
      "on_waivers",
      "waiver_clears_at",
      "avg_points",
      "games",
      "last_points",
      "next_opponent",
      "next_kickoff",
      "next_is_home",
      "total_count",
      "status",
    ]) {
      assert.ok(!(gone in slim), `${gone} must not ship to the draft room`);
    }
  });

  test("passes the kept values through untouched", () => {
    const slim = toDraftablePlayer(
      rpcRow({ player_id: "P1", adp: null, proj_points: null, bye_week: null }),
    );
    assert.equal(slim.player_id, "P1");
    assert.equal(slim.full_name, "Pool Player");
    assert.equal(slim.pos, "WR");
    assert.equal(slim.total_points, 123.4);
    assert.equal(slim.adp, null, "a null stays null, not 0");
    assert.equal(slim.proj_points, null);
    assert.equal(slim.bye_week, null);
  });
});

describe("DRAFT_POOL_RENDER_LIMIT", () => {
  test("renders fewer than the 500 the server ships, but enough to draft from", () => {
    // Below the server's pool so the DOM is bounded, well above a single
    // draft's worth of picks so narrowing is never the only way to reach
    // a pickable player.
    assert.ok(DRAFT_POOL_RENDER_LIMIT < 500);
    assert.ok(DRAFT_POOL_RENDER_LIMIT >= 100);
  });
});
