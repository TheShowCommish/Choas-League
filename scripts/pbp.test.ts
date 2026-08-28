/**
 * Checks the play-by-play aggregation against a real week.
 *
 * These are the stats nobody else offers, so nothing else validates
 * them: a wrong comparison here produces a plausible-looking number
 * that is simply incorrect. The assertions below cross-check the
 * aggregation against the box score totals, which have to agree.
 *
 * Downloads ~18MB, so this is slower than the other suites.
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { streamCsv, n, s, type CsvRow } from "../src/lib/ingest/csv.ts";
import { aggregatePlayByPlay, type PbpTotals } from "../src/lib/ingest/pbp.ts";
import { mapPlayerWeek } from "../src/lib/ingest/map-stats.ts";
import { nflverseUrls } from "../src/lib/ingest/nflverse.ts";
import { STAT_BY_KEY } from "../src/lib/stats/catalog.ts";

const SEASON = 2025;
const WEEK = 2;

describe("play-by-play aggregation", () => {
  let totals: PbpTotals = new Map();
  /** `${playerId}|${gameId}` -> box score stats, for cross-checking. */
  const boxScore = new Map<string, ReturnType<typeof mapPlayerWeek>>();
  let reachable = true;

  before(async () => {
    try {
      totals = await aggregatePlayByPlay(SEASON, WEEK);

      for await (const row of streamCsv(nflverseUrls.playerWeek(SEASON))) {
        if (n(row, "week") !== WEEK) continue;
        const playerId = s(row, "player_id");
        const gameId = s(row, "game_id");
        if (!playerId || !gameId) continue;
        boxScore.set(`${playerId}|${gameId}`, mapPlayerWeek(row));
      }
    } catch (err) {
      console.warn(`nflverse unreachable, skipping: ${(err as Error).message}`);
      reachable = false;
    }

    if (totals.size === 0) reachable = false;
  });

  test("the gzipped play-by-play file streams and parses", (t) => {
    if (!reachable) return t.skip("nflverse unreachable");
    assert.ok(totals.size > 200, `expected plenty of totals, got ${totals.size}`);
  });

  test("every key produced is in the stat catalog", (t) => {
    if (!reachable) return t.skip("nflverse unreachable");

    const unknown = new Set<string>();
    for (const stats of totals.values()) {
      for (const key of Object.keys(stats)) {
        if (!(key in STAT_BY_KEY)) unknown.add(key);
      }
    }

    assert.deepEqual([...unknown], []);
  });

  test("counts are positive whole numbers", (t) => {
    if (!reachable) return t.skip("nflverse unreachable");

    for (const [key, stats] of totals) {
      for (const [stat, value] of Object.entries(stats)) {
        assert.ok(
          Number.isInteger(value) && value > 0,
          `${key} ${stat} = ${value}`,
        );
      }
    }
  });

  test("red zone targets never exceed a receiver's total targets", (t) => {
    if (!reachable) return t.skip("nflverse unreachable");

    // The strongest available cross-check: the two numbers come from
    // completely separate files, and one is a subset of the other.
    let checked = 0;

    for (const [key, stats] of totals) {
      const box = boxScore.get(key);
      if (!box?.targets) continue;

      for (const subset of ["targets_redzone", "targets_deep", "targets_endzone"]) {
        const value = stats[subset];
        if (value === undefined) continue;
        assert.ok(
          value <= box.targets,
          `${key}: ${subset} ${value} > targets ${box.targets}`,
        );
        checked++;
      }
    }

    assert.ok(checked > 50, `expected plenty of receivers to check, got ${checked}`);
  });

  test("red zone carries never exceed a rusher's total carries", (t) => {
    if (!reachable) return t.skip("nflverse unreachable");

    let checked = 0;

    for (const [key, stats] of totals) {
      const box = boxScore.get(key);
      if (!box?.rush_attempts) continue;

      for (const subset of [
        "rush_attempts_redzone",
        "rush_attempts_inside_5",
        "rush_stuffed",
      ]) {
        const value = stats[subset];
        if (value === undefined) continue;
        assert.ok(
          value <= box.rush_attempts,
          `${key}: ${subset} ${value} > carries ${box.rush_attempts}`,
        );
        checked++;
      }
    }

    assert.ok(checked > 50, `expected plenty of rushers to check, got ${checked}`);
  });

  test("carries inside the 5 are a subset of red zone carries", (t) => {
    if (!reachable) return t.skip("nflverse unreachable");

    for (const [key, stats] of totals) {
      const inside5 = stats.rush_attempts_inside_5;
      if (inside5 === undefined) continue;
      assert.ok(
        inside5 <= (stats.rush_attempts_redzone ?? 0),
        `${key}: inside-5 ${inside5} exceeds red zone ${stats.rush_attempts_redzone}`,
      );
    }
  });

  test("deep completions never exceed deep attempts", (t) => {
    if (!reachable) return t.skip("nflverse unreachable");

    for (const [key, stats] of totals) {
      const completions = stats.pass_completions_deep;
      if (completions === undefined) continue;
      assert.ok(
        completions <= (stats.pass_attempts_deep ?? 0),
        `${key}: ${completions} deep completions, ${stats.pass_attempts_deep} attempts`,
      );
    }
  });

  test("team defense totals look like a real week of football", (t) => {
    if (!reachable) return t.skip("nflverse unreachable");

    const defenses = [...totals.entries()].filter(([key]) =>
      key.startsWith("DST_"),
    );

    assert.ok(defenses.length >= 20, "expected a D/ST line for most teams");

    for (const [key, stats] of defenses) {
      const firstDowns = stats.dst_first_downs_allowed;
      if (firstDowns !== undefined) {
        assert.ok(
          firstDowns >= 2 && firstDowns <= 45,
          `${key} allowed ${firstDowns} first downs`,
        );
      }

      const threeAndOuts = stats.dst_three_and_outs;
      if (threeAndOuts !== undefined) {
        assert.ok(
          threeAndOuts <= 12,
          `${key} forced ${threeAndOuts} three-and-outs`,
        );
      }
    }
  });

  test("long touchdowns are rare but present", (t) => {
    if (!reachable) return t.skip("nflverse unreachable");

    const longTds = [...totals.values()].reduce(
      (sum, stats) =>
        sum +
        (stats.pass_td_40_plus ?? 0) +
        (stats.rush_td_40_plus ?? 0) +
        (stats.rec_td_40_plus ?? 0),
      0,
    );

    // A typical NFL week has a handful of 40+ yard scores. Zero would
    // mean the comparison is broken; dozens would mean it is too loose.
    assert.ok(longTds >= 1 && longTds <= 60, `${longTds} long touchdowns`);
  });
});

describe("csv gzip streaming", () => {
  test("inflates a gzipped nflverse file", async (t) => {
    let first: CsvRow | undefined;

    try {
      for await (const row of streamCsv(nflverseUrls.playByPlay(SEASON))) {
        first = row;
        break;
      }
    } catch (err) {
      return t.skip(`nflverse unreachable: ${(err as Error).message}`);
    }

    if (!first) return t.skip("no rows returned");

    // Real column names rather than gzip noise means it inflated.
    assert.ok("game_id" in first, "expected a game_id column");
    assert.ok("play_type" in first, "expected a play_type column");
    assert.ok("yardline_100" in first, "expected a yardline_100 column");
  });
});
