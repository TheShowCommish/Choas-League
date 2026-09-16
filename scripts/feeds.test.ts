/**
 * The new outside feeds, against the live services.
 *
 * All three are undocumented and unofficial, so the shape can change
 * without notice and the only way to find out is to ask. These tests
 * hit the network and skip rather than fail when a service is
 * unreachable -- a feed being down is not a broken repository.
 *
 * What they check is the thing a unit test cannot: that the fields we
 * read still exist and still mean what the parsers assume.
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import {
  fetchMockDraftAdp,
  type MockAdpResult,
} from "../src/lib/ingest/mock-draft-adp.ts";
import {
  buildSleeperIdMap,
  fetchSeasonProjections,
  fetchSleeperPlayers,
  injuriesFrom,
  type SleeperInjury,
  type SleeperPlayerRow,
  type SleeperSeasonProjection,
} from "../src/lib/ingest/sleeper.ts";
import { PlayerIndex } from "../src/lib/ingest/player-match.ts";
import { fetchPlayerResearch } from "../src/lib/research/news.ts";
import { currentSeason } from "../src/lib/ingest/nflverse.ts";

const SEASON = currentSeason();

/** Patrick Mahomes. A player ESPN will always have something about. */
const ESPN_ID = "3139477";

describe("mock-draft ADP", () => {
  let result: MockAdpResult | null = null;

  before(async () => {
    try {
      result = await fetchMockDraftAdp(SEASON);
    } catch {
      result = null;
    }
  });

  test("comes back as an ordered board", (t) => {
    if (!result) return t.skip("Fantasy Football Calculator unreachable");

    assert.ok(result.entries.length > 100, "a board, not a handful");
    assert.ok(result.totalDrafts > 0, "averaged over actual drafts");

    for (let i = 1; i < result.entries.length; i++) {
      assert.ok(
        result.entries[i].adp >= result.entries[i - 1].adp,
        "ADP ascends",
      );
      assert.equal(result.entries[i].rank, i + 1, "rank follows ADP");
    }
  });

  test("the first pick is a real player at a real position", (t) => {
    if (!result) return t.skip("Fantasy Football Calculator unreachable");

    const first = result.entries[0];
    assert.ok(first.name.length > 2, `got "${first.name}"`);
    assert.ok(
      ["QB", "RB", "WR", "TE"].includes(first.position ?? ""),
      `nobody drafts a ${first.position} first`,
    );
    assert.ok(first.adp < 5, "the first pick goes in the first round");
  });

  test("positions and teams are in our vocabulary, not theirs", (t) => {
    if (!result) return t.skip("Fantasy Football Calculator unreachable");

    const positions = new Set(result.entries.map((e) => e.position));
    assert.ok(!positions.has("PK"), "PK should have become K");
    assert.ok(positions.has("K"), "and kickers should still be there");

    const teams = new Set(result.entries.map((e) => e.team));
    assert.ok(!teams.has("LAR"), "LAR should have become LA");
    assert.ok(!teams.has("JAC"), "JAC should have become JAX");
  });
});

/**
 * A stand-in for our own player table.
 *
 * The real one comes out of nflverse and is not available to a test
 * without a database, so this uses Sleeper's own roster as the thing to
 * match against -- with our ids faked from the gsis id where there is
 * one. It exercises the matcher for real: the names, positions and
 * teams are the ones the live feeds actually publish.
 */
function fakeOurPlayers(dump: SleeperPlayerRow[]) {
  return dump
    .filter((row) => row.team && row.position)
    .map((row) => ({
      id: row.gsisId ?? `FAKE_${row.sleeperId}`,
      full_name: row.fullName,
      position: row.position,
      team_abbr: row.team,
    }));
}

describe("season projections", () => {
  let projections: SleeperSeasonProjection[] | null = null;
  let coverage = 0;

  before(async () => {
    try {
      const dump = await fetchSleeperPlayers();
      const players = fakeOurPlayers(dump);
      const idMap = buildSleeperIdMap(
        dump,
        new PlayerIndex(players),
        new Set(players.map((p) => p.id)),
      );
      coverage = idMap.size;
      projections = await fetchSeasonProjections(SEASON, idMap);
    } catch {
      projections = null;
    }
  });

  test("the id mapping reaches the players people actually draft", (t) => {
    if (!projections) return t.skip("Sleeper unreachable");

    /*
     * The bug this matcher exists for: Sleeper has stopped filling in
     * gsis_id, and the four most-drafted players in the game all come
     * back with null. A mapping built on that field alone resolved
     * about a thousand of twelve thousand, and none of the ones anybody
     * wanted.
     */
    assert.ok(
      coverage > 3000,
      `only ${coverage} Sleeper ids resolved -- the matcher is not working`,
    );
  });

  test("come back as stat lines keyed by our player ids", (t) => {
    if (!projections) return t.skip("Sleeper unreachable");
    if (projections.length === 0) {
      return t.skip(`Sleeper has published nothing for ${SEASON} yet`);
    }

    assert.ok(projections.length > 100, "a season's worth of players");

    for (const row of projections.slice(0, 50)) {
      assert.ok(row.playerId.length > 0, "every row carries an id");
      assert.ok(
        Object.keys(row.stats).length > 0,
        "an empty stat line should have been dropped",
      );
    }
  });

  test("the stat keys are ones our catalog scores", async (t) => {
    if (!projections || projections.length === 0) {
      return t.skip("no projections to check");
    }

    const { STAT_BY_KEY } = await import("../src/lib/stats/catalog.ts");
    const keys = new Set(projections.flatMap((p) => Object.keys(p.stats)));

    for (const key of keys) {
      assert.ok(STAT_BY_KEY[key], `"${key}" is not in the stat catalog`);
    }
  });

  test("a season total is a season, not a week", (t) => {
    if (!projections || projections.length === 0) {
      return t.skip("no projections to check");
    }

    // The best projected receiver in the league goes for well over a
    // thousand yards across a season and nothing like it in a week.
    const best = Math.max(
      ...projections.map((p) => p.stats.receiving_yards ?? 0),
    );
    assert.ok(best > 600, `best projected receiving yards was ${best}`);
  });
});

describe("injuries", () => {
  let injuries: SleeperInjury[] | null = null;

  before(async () => {
    try {
      const dump = await fetchSleeperPlayers();
      const players = fakeOurPlayers(dump);
      injuries = injuriesFrom(
        dump,
        buildSleeperIdMap(
          dump,
          new PlayerIndex(players),
          new Set(players.map((p) => p.id)),
        ),
      );
    } catch {
      injuries = null;
    }
  });

  test("healthy players carry nothing at all", (t) => {
    if (!injuries) return t.skip("Sleeper unreachable");

    assert.ok(injuries.length > 1000, "the whole player dump");

    // "Active" is Sleeper's way of saying nothing is wrong, and it must
    // not reach the page as a designation.
    for (const injury of injuries) {
      if (injury.status === null) continue;
      assert.notEqual(injury.status.toLowerCase(), "active");
    }
  });

  test("the hurt ones are a minority, and they say what is hurt", (t) => {
    if (!injuries) return t.skip("Sleeper unreachable");

    const hurt = injuries.filter((i) => i.status !== null);
    assert.ok(hurt.length > 0, "somebody in the NFL is always hurt");
    assert.ok(
      hurt.length < injuries.length / 2,
      "more than half the league hurt means the field is being misread",
    );
    assert.ok(
      hurt.some((i) => i.bodyPart),
      "at least some carry a body part",
    );
  });
});

describe("player news", () => {
  test("is about the player, not about the league", async (t) => {
    const { news, blurb } = await fetchPlayerResearch(ESPN_ID);

    if (news.length === 0 && !blurb) {
      return t.skip("ESPN unreachable, or nothing filed");
    }

    /*
     * The bug this endpoint change fixes: the league news feed ignores
     * its `athlete` parameter and returns the same headlines for
     * everybody. Asking a second, unrelated player and getting an
     * identical list back is exactly what that looked like.
     */
    const other = await fetchPlayerResearch("4362628"); // Justin Jefferson

    if (other.news.length > 0 && news.length > 0) {
      const overlap = news.filter((a) =>
        other.news.some((b) => b.id === a.id),
      );
      assert.ok(
        overlap.length < news.length,
        "two different players came back with the same news",
      );
    }
  });

  test("an unknown player is empty rather than an error", async () => {
    const result = await fetchPlayerResearch("0");
    assert.deepEqual(result, { news: [], blurb: null });
  });

  test("a player with no espn id asks nothing", async () => {
    const result = await fetchPlayerResearch(null);
    assert.deepEqual(result, { news: [], blurb: null });
  });
});
