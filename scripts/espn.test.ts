/**
 * Checks the ESPN live-scoring mapping against a real completed game.
 *
 * ESPN's endpoints are undocumented, so the shape can change without
 * notice. A completed game is used deliberately: the final numbers are
 * known, which makes it possible to assert real values rather than
 * merely "something came back".
 *
 * Hits the network; skips rather than fails when ESPN is unreachable.
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import {
  espnDate,
  fetchBoxScore,
  fetchScoreboard,
  type EspnBoxScore,
  type EspnGame,
} from "../src/lib/ingest/espn.ts";
import { STAT_BY_KEY } from "../src/lib/stats/catalog.ts";

// Jaguars at Bengals, week 2 of 2025: Cincinnati won 31-27.
const GAME_DATE = new Date("2025-09-14T12:00:00Z");
const EVENT_ID = "401772725";

describe("espn date formatting", () => {
  test("uses the yyyymmdd the scoreboard expects", () => {
    assert.equal(espnDate(new Date("2025-09-14T23:00:00Z")), "20250914");
    assert.equal(espnDate(new Date("2026-01-04T00:30:00Z")), "20260104");
  });
});

describe("espn live scoring", () => {
  let games: EspnGame[] = [];
  let box: EspnBoxScore | null = null;
  let reachable = true;

  before(async () => {
    try {
      games = await fetchScoreboard(GAME_DATE);
      box = await fetchBoxScore(EVENT_ID);
    } catch (err) {
      console.warn(`ESPN unreachable, skipping: ${(err as Error).message}`);
      reachable = false;
    }
  });

  test("the scoreboard still parses", (t) => {
    if (!reachable) return t.skip("ESPN unreachable");

    assert.ok(games.length > 0, "expected games on that Sunday");

    const game = games.find((g) => g.eventId === EVENT_ID);
    assert.ok(game, "expected the Jaguars-Bengals game");
    assert.equal(game.homeAbbr, "CIN");
    assert.equal(game.awayAbbr, "JAX");
    assert.equal(game.homeScore, 31);
    assert.equal(game.awayScore, 27);
    assert.equal(game.completed, true);
    assert.equal(game.state, "post");
    assert.equal(game.week, 2);
  });

  test("every key the box score produces is in the catalog", (t) => {
    if (!reachable || !box) return t.skip("ESPN unreachable");

    const unknown = new Set<string>();
    for (const stats of [...box.players.values(), ...box.defenses.values()]) {
      for (const key of Object.keys(stats)) {
        if (!(key in STAT_BY_KEY)) unknown.add(key);
      }
    }

    assert.deepEqual([...unknown], [], "keys not present in the stat catalog");
  });

  test("a known passing line comes through correctly", (t) => {
    if (!reachable || !box) return t.skip("ESPN unreachable");

    // Trevor Lawrence: 24/42, 271 yards, 3 TDs, 2 INTs, sacked once.
    const stats = box.players.get("4360310");
    assert.ok(stats, "expected Trevor Lawrence in the box score");

    assert.equal(stats.pass_completions, 24);
    assert.equal(stats.pass_attempts, 42);
    assert.equal(stats.pass_incompletions, 18);
    assert.equal(stats.passing_yards, 271);
    assert.equal(stats.passing_tds, 3);
    assert.equal(stats.interceptions_thrown, 2);
    assert.equal(stats.sacks_taken, 1);
    assert.equal(stats.sack_yards_lost, 10);

    // Under 300, so no milestone flag should be stored at all.
    assert.equal(stats.pass_300_bonus, undefined);
  });

  test("receiving and return lines merge onto one player", (t) => {
    if (!reachable || !box) return t.skip("ESPN unreachable");

    // Parker Washington: 5 catches for 76, plus kick and punt returns.
    const stats = box.players.get("4432620");
    assert.ok(stats, "expected Parker Washington in the box score");

    assert.equal(stats.receptions, 5);
    assert.equal(stats.receiving_yards, 76);
    assert.equal(stats.targets, 5);
    assert.equal(stats.kick_returns, 3);
    assert.equal(stats.kick_return_yards, 75);
    assert.equal(stats.punt_returns, 2);
    assert.equal(stats.punt_return_yards, 19);

    // Return yards count toward all-purpose but not scrimmage.
    assert.equal(stats.total_yards_from_scrimmage, 76);
    assert.equal(stats.all_purpose_yards, 76 + 75 + 19);
  });

  test("kicking is split out of the combined made/attempted cell", (t) => {
    if (!reachable || !box) return t.skip("ESPN unreachable");

    // Cam Little: 2/2 field goals, 3/3 extra points.
    const stats = box.players.get("4686361");
    assert.ok(stats, "expected Cam Little in the box score");

    assert.equal(stats.fg_made, 2);
    assert.equal(stats.fg_attempts, 2);
    assert.equal(stats.fg_missed, undefined, "no misses means no stored zero");
    assert.equal(stats.pat_made, 3);
    assert.equal(stats.pat_attempts, 3);
  });

  test("team defense reads the opponent's output", (t) => {
    if (!reachable || !box) return t.skip("ESPN unreachable");

    // Jacksonville's defense allowed Cincinnati's 31 points.
    const jax = box.defenses.get("JAX");
    assert.ok(jax, "expected a Jacksonville defensive line");
    assert.equal(jax.dst_points_allowed, 31);
    assert.equal(jax.dst_pa_28_34, 1);
    assert.equal(jax.dst_pa_21_27, undefined);

    // And Cincinnati's allowed Jacksonville's 27 and their 400 yards.
    const cin = box.defenses.get("CIN");
    assert.ok(cin, "expected a Cincinnati defensive line");
    assert.equal(cin.dst_points_allowed, 27);
    assert.equal(cin.dst_yards_allowed, 400);
    assert.equal(cin.dst_pass_yards_allowed, 261);
    assert.equal(cin.dst_rush_yards_allowed, 139);
    assert.equal(cin.dst_interceptions, 2, "Jacksonville threw two picks");
    assert.equal(cin.dst_ya_400_449, 1);
  });

  test("no stat is stored as an explicit zero", (t) => {
    if (!reachable || !box) return t.skip("ESPN unreachable");

    for (const [id, stats] of box.players) {
      for (const [key, value] of Object.entries(stats)) {
        assert.notEqual(value, 0, `${id} stored ${key} as zero`);
      }
    }
  });
});
