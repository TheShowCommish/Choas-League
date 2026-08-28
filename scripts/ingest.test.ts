/**
 * Checks the ingestion mapping against real nflverse data.
 *
 * The mapping is the riskiest part of the system and the hardest to
 * eyeball: a mistyped key produces a stat that silently never scores,
 * and a mismatched column name produces a silent zero. Both look
 * exactly like "that player had a quiet week".
 *
 * These tests hit the network. They skip rather than fail if nflverse
 * is unreachable, so a flaky connection does not break the suite.
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { splitCsvLine, streamCsv, n, type CsvRow } from "../src/lib/ingest/csv.ts";
import {
  mapPlayerWeek,
  mapTeamDefense,
  mapAdvRush,
  mapSnapCounts,
} from "../src/lib/ingest/map-stats.ts";
import { nflverseUrls, normalizeTeam } from "../src/lib/ingest/nflverse.ts";
import { STAT_BY_KEY } from "../src/lib/stats/catalog.ts";

/** The most recent completed season, so the files definitely exist. */
const SEASON = 2025;

describe("csv parsing", () => {
  test("splits quoted fields, embedded commas and doubled quotes", () => {
    assert.deepEqual(splitCsvLine("a,b,c"), ["a", "b", "c"]);
    assert.deepEqual(splitCsvLine('a,"b,c",d'), ["a", "b,c", "d"]);
    assert.deepEqual(splitCsvLine('a,"say ""hi""",c'), ["a", 'say "hi"', "c"]);
    assert.deepEqual(splitCsvLine("a,,c"), ["a", "", "c"]);
    assert.deepEqual(splitCsvLine(""), [""]);
  });

  test("reads NA and blanks as zero", () => {
    const row: CsvRow = { a: "NA", b: "", c: "12.5", d: "oops" };
    assert.equal(n(row, "a"), 0);
    assert.equal(n(row, "b"), 0);
    assert.equal(n(row, "c"), 12.5);
    assert.equal(n(row, "d"), 0);
    assert.equal(n(row, "missing"), 0);
  });
});

describe("team normalisation", () => {
  test("maps relocated franchises onto current codes", () => {
    assert.equal(normalizeTeam("OAK"), "LV");
    assert.equal(normalizeTeam("SD"), "LAC");
    assert.equal(normalizeTeam("STL"), "LA");
    assert.equal(normalizeTeam("LAR"), "LA");
    assert.equal(normalizeTeam("KC"), "KC");
    assert.equal(normalizeTeam(null), null);
  });
});

// ---------------------------------------------------------------------------

describe("nflverse mapping", () => {
  const playerRows: CsvRow[] = [];
  const teamRows: CsvRow[] = [];
  let reachable = true;

  before(async () => {
    try {
      for await (const row of streamCsv(nflverseUrls.playerWeek(SEASON))) {
        playerRows.push(row);
        if (playerRows.length >= 4000) break;
      }
      for await (const row of streamCsv(nflverseUrls.teamWeek(SEASON))) {
        teamRows.push(row);
        if (teamRows.length >= 200) break;
      }
    } catch (err) {
      console.warn(`nflverse unreachable, skipping: ${(err as Error).message}`);
      reachable = false;
    }

    if (playerRows.length === 0) reachable = false;
  });

  test("the weekly stats file is still where we expect it", (t) => {
    if (!reachable) return t.skip("nflverse unreachable");
    assert.ok(playerRows.length > 100, "expected plenty of rows");
  });

  test("every key we emit exists in the stat catalog", (t) => {
    if (!reachable) return t.skip("nflverse unreachable");

    const unknown = new Set<string>();
    for (const row of playerRows) {
      for (const key of Object.keys(mapPlayerWeek(row))) {
        if (!(key in STAT_BY_KEY)) unknown.add(key);
      }
    }

    assert.deepEqual(
      [...unknown],
      [],
      "these keys are produced by ingestion but are not in the catalog, " +
        "so nothing could ever score them",
    );
  });

  test("the columns we read actually exist in the file", (t) => {
    if (!reachable) return t.skip("nflverse unreachable");

    // Every column mapPlayerWeek reads by name. If nflverse renames one,
    // n() quietly returns 0 and the stat vanishes -- so assert directly.
    const required = [
      "completions", "attempts", "passing_yards", "passing_tds",
      "passing_interceptions", "sacks_suffered", "sack_yards_lost",
      "passing_first_downs", "passing_air_yards", "passing_yards_after_catch",
      "passing_2pt_conversions", "passing_epa", "passing_20", "passing_40",
      "passing_cpoe", "pacr",
      "carries", "rushing_yards", "rushing_tds", "rushing_first_downs",
      "rushing_epa", "rushing_2pt_conversions", "rushing_fumbles",
      "rushing_fumbles_lost", "rushing_10", "rushing_20", "rushing_40",
      "receptions", "targets", "receiving_yards", "receiving_tds",
      "receiving_first_downs", "receiving_air_yards",
      "receiving_yards_after_catch", "receiving_epa",
      "receiving_2pt_conversions", "receiving_fumbles",
      "receiving_fumbles_lost", "receiving_20", "receiving_40",
      "racr", "target_share", "air_yards_share", "wopr",
      "fg_made", "fg_att", "fg_missed", "fg_long", "fg_made_distance",
      "fg_made_0_19", "fg_made_20_29", "fg_made_30_39", "fg_made_40_49",
      "fg_made_50_59", "fg_made_60_", "fg_missed_0_19", "fg_missed_20_29",
      "fg_missed_30_39", "fg_missed_40_49", "fg_missed_50_59", "fg_missed_60_",
      "pat_made", "pat_att", "pat_missed",
      "fumbles_total", "fumbles_lost_total", "fumble_recovery_own",
      "fumble_recovery_opp", "fumble_recovery_yards_opp", "fumble_recovery_tds",
      "kickoff_returns", "kickoff_return_yards", "punt_returns",
      "punt_return_yards", "special_teams_tds",
      "def_tackles_solo", "def_tackle_assists", "def_tackles_for_loss",
      "def_sacks", "def_sack_yards", "def_qb_hits", "def_interceptions",
      "def_interception_yards", "def_pass_defended", "def_fumbles_forced",
      "def_safeties", "def_punt_blocks", "def_pat_blocks", "def_fg_blocks",
      "def_tds",
    ];

    const present = new Set(Object.keys(playerRows[0]));
    const missing = required.filter((c) => !present.has(c));

    assert.deepEqual(missing, [], "nflverse columns we read that no longer exist");
  });

  test("a real passing line maps to sensible numbers", (t) => {
    if (!reachable) return t.skip("nflverse unreachable");

    // The biggest passing game in the sample, so the numbers are known
    // to be non-trivial.
    const best = playerRows.reduce((a, b) =>
      n(b, "passing_yards") > n(a, "passing_yards") ? b : a,
    );
    const stats = mapPlayerWeek(best);

    assert.equal(stats.passing_yards, n(best, "passing_yards"));
    assert.equal(stats.pass_attempts, n(best, "attempts"));
    assert.equal(
      stats.pass_incompletions,
      n(best, "attempts") - n(best, "completions"),
    );
    assert.ok(stats.passing_yards > 200, "expected a real passing game");

    // Milestone flags are 0/1, never the yardage itself.
    if (stats.passing_yards >= 300) {
      assert.equal(stats.pass_300_bonus, 1);
    }
    for (const key of Object.keys(stats)) {
      if (STAT_BY_KEY[key]?.valueType === "flag") {
        assert.equal(stats[key], 1, `${key} should be exactly 1 when present`);
      }
    }
  });

  test("a real rushing line maps to sensible numbers", (t) => {
    if (!reachable) return t.skip("nflverse unreachable");

    const best = playerRows.reduce((a, b) =>
      n(b, "rushing_yards") > n(a, "rushing_yards") ? b : a,
    );
    const stats = mapPlayerWeek(best);

    assert.equal(stats.rushing_yards, n(best, "rushing_yards"));
    assert.equal(stats.rush_attempts, n(best, "carries"));
    assert.equal(
      stats.total_yards_from_scrimmage,
      n(best, "rushing_yards") + n(best, "receiving_yards"),
    );
    assert.equal(
      stats.total_touches,
      n(best, "carries") + n(best, "receptions"),
    );
    assert.ok(stats.rushing_yards >= 100, "expected a 100-yard game in the sample");
    assert.equal(stats.rush_100_bonus, 1);
  });

  test("zero-valued stats are dropped rather than stored", (t) => {
    if (!reachable) return t.skip("nflverse unreachable");

    // A kicker records no receiving stats; those keys should be absent,
    // not present as zero, or every row would carry 150 columns.
    for (const row of playerRows) {
      const stats = mapPlayerWeek(row);
      for (const [key, value] of Object.entries(stats)) {
        assert.notEqual(value, 0, `${key} was stored as an explicit zero`);
      }
    }
  });

  test("standard PPR scoring reproduces the nflverse total", (t) => {
    if (!reachable) return t.skip("nflverse unreachable");

    // nflverse computes fantasy_points_ppr itself. Scoring our mapped
    // stats with the same rules should land on the same number -- the
    // strongest end-to-end check that the mapping is right.
    //
    // One deliberate difference: nflverse penalises only fumbles lost on
    // a pass, run or sack, while our `fumbles_lost` maps the player's
    // total (fumbles_lost_total), which also covers returns and aborted
    // snaps. That is the more complete fantasy rule, so the reference
    // formula below uses nflverse's narrower definition to isolate the
    // mapping rather than re-litigate the scoring choice.
    const scorers = playerRows
      .filter((r) => n(r, "fantasy_points_ppr") > 5)
      .slice(0, 300);

    assert.ok(scorers.length > 20, "expected some scorers in the sample");

    for (const row of scorers) {
      const s = mapPlayerWeek(row);
      const ours =
        (s.passing_yards ?? 0) * 0.04 +
        (s.passing_tds ?? 0) * 4 +
        (s.interceptions_thrown ?? 0) * -2 +
        (s.rushing_yards ?? 0) * 0.1 +
        (s.rushing_tds ?? 0) * 6 +
        (s.receiving_yards ?? 0) * 0.1 +
        (s.receiving_tds ?? 0) * 6 +
        (s.receptions ?? 0) * 1 +
        (s.special_teams_tds ?? 0) * 6 +
        (s.pass_2pt_conversions ?? 0) * 2 +
        (s.rush_2pt_conversions ?? 0) * 2 +
        (s.rec_2pt_conversions ?? 0) * 2 +
        (n(row, "rushing_fumbles_lost") +
          n(row, "receiving_fumbles_lost") +
          n(row, "sack_fumbles_lost")) *
          -2;

      const theirs = n(row, "fantasy_points_ppr");
      assert.ok(
        Math.abs(ours - theirs) < 0.5,
        `${row.player_display_name} wk${row.week}: we scored ${ours.toFixed(2)}, ` +
          `nflverse says ${theirs.toFixed(2)}`,
      );
    }
  });

  test("team defense reads the opponent's output as yards allowed", (t) => {
    if (!reachable || teamRows.length === 0) {
      return t.skip("nflverse unreachable");
    }

    const row = teamRows[0];
    const stats = mapTeamDefense(row, {
      points: 3,
      passYards: 150,
      rushYards: 60,
    });

    assert.equal(stats.dst_points_allowed, 3);
    assert.equal(stats.dst_yards_allowed, 210);
    assert.equal(stats.dst_pass_yards_allowed, 150);
    assert.equal(stats.dst_rush_yards_allowed, 60);
    assert.equal(stats.dst_pa_1_6, 1, "3 points allowed is the 1-6 tier");
    assert.equal(stats.dst_pa_0, undefined, "and not the shutout tier");
    assert.equal(stats.dst_ya_200_299, 1);

    for (const key of Object.keys(stats)) {
      assert.ok(key in STAT_BY_KEY, `${key} is not in the catalog`);
    }
  });

  test("a shutout sets the shutout flags and nothing else", () => {
    const stats = mapTeamDefense({} as CsvRow, {
      points: 0,
      passYards: 90,
      rushYards: 5,
    });

    assert.equal(stats.dst_shutout, 1);
    assert.equal(stats.dst_pa_0, 1);
    assert.equal(stats.dst_pa_1_6, undefined);
    assert.equal(stats.dst_ya_under_100, 1);
    // Zero points allowed must not be stored as a scorable count of 0.
    assert.equal(stats.dst_points_allowed, undefined);
  });

  test("fumbles_lost counts every lost fumble, not just scrimmage ones", (t) => {
    if (!reachable) return t.skip("nflverse unreachable");

    // A player can lose a fumble on a return or an aborted snap, which
    // the position-specific columns miss. We score the total on purpose,
    // so assert the mapping reads the total column.
    const wider = playerRows.find(
      (r) =>
        n(r, "fumbles_lost_total") >
        n(r, "rushing_fumbles_lost") + n(r, "receiving_fumbles_lost") +
          n(r, "sack_fumbles_lost"),
    );

    if (!wider) return t.skip("no such fumble in the sample");

    const stats = mapPlayerWeek(wider);
    assert.equal(stats.fumbles_lost, n(wider, "fumbles_lost_total"));
  });

  test("supplementary feeds only emit catalog keys", () => {
    const rush = mapAdvRush({
      rushing_yards_before_contact: "40",
      rushing_yards_after_contact: "35",
      rushing_broken_tackles: "3",
    } as CsvRow);
    assert.deepEqual(rush, {
      rush_yards_before_contact: 40,
      rush_yards_after_contact: 35,
      rush_broken_tackles: 3,
    });

    const snaps = mapSnapCounts({
      offense_snaps: "58",
      defense_snaps: "0",
      offense_pct: "0.87",
    } as CsvRow);
    assert.deepEqual(snaps, { offensive_snaps: 58, snap_share: 0.87 });

    for (const key of [...Object.keys(rush), ...Object.keys(snaps)]) {
      assert.ok(key in STAT_BY_KEY, `${key} is not in the catalog`);
    }
  });
});
