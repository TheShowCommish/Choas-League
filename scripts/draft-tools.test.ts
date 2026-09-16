/**
 * The pure halves of the draft board and the lineup.
 *
 * Three things here are easy to get subtly wrong and impossible to spot
 * by looking at a screen: matching a mock draft's names onto our player
 * ids, reading an injury designation into an actual expectation, and
 * dealing an over-full roster into a board that cannot hold it.
 *
 * No network and no database -- all three are functions of their
 * arguments, which is why they were pulled out of the components in the
 * first place.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  matchMockAdp,
  matchName,
  parseMockAdp,
  type MockAdpResult,
} from "../src/lib/ingest/mock-draft-adp.ts";
import { describeInjury } from "../src/lib/injury.ts";
import { autoFill, type LineupSpot } from "../src/lib/lineup.ts";

describe("normalising a name for matching", () => {
  test("punctuation and case are not differences", () => {
    assert.equal(matchName("Ja'Marr Chase"), matchName("JaMarr Chase"));
    assert.equal(matchName("D.K. Metcalf"), matchName("DK Metcalf"));
    assert.equal(matchName("A.J. Brown"), matchName("AJ  Brown"));
  });

  test("a generational suffix is not a difference either", () => {
    assert.equal(
      matchName("Marvin Harrison Jr."),
      matchName("Marvin Harrison"),
    );
    assert.equal(matchName("Odell Beckham Jr"), matchName("Odell Beckham"));
  });

  test("accents survive as their bare letters", () => {
    assert.equal(matchName("José Álvarez"), "jose alvarez");
  });

  test("two different people stay different", () => {
    assert.notEqual(matchName("Josh Allen"), matchName("Keenan Allen"));
  });
});

describe("reading a mock-draft payload", () => {
  const payload = {
    status: "Success",
    meta: { total_drafts: 1834 },
    players: [
      { name: "Ja'Marr Chase", position: "WR", team: "CIN", adp: 1.4 },
      { name: "Bijan Robinson", position: "RB", team: "ATL", adp: 2.1 },
      // Their vocabulary, not ours: PK is a kicker.
      { name: "Brandon Aubrey", position: "PK", team: "DAL", adp: 110.2 },
      // Their abbreviation, not nflverse's.
      { name: "Ravens", position: "DEF", team: "BAL", adp: 95.6 },
      { name: "Jaguars", position: "DEF", team: "JAC", adp: 140.0 },
      // Nobody has drafted him; 0 would sort him first.
      { name: "Nobody At All", position: "WR", team: "NYJ", adp: 0 },
    ],
  };

  test("positions and teams are translated into ours", () => {
    const { entries } = parseMockAdp(payload, "ppr", 12);
    const kicker = entries.find((e) => e.name === "Brandon Aubrey");
    const jags = entries.find((e) => e.name === "Jaguars");

    assert.equal(kicker?.position, "K", "PK should become K");
    assert.equal(jags?.team, "JAX", "JAC should become JAX");
  });

  test("an ADP of zero is dropped rather than sorted first", () => {
    const { entries } = parseMockAdp(payload, "ppr", 12);
    assert.ok(!entries.some((e) => e.name === "Nobody At All"));
    assert.equal(entries[0].name, "Ja'Marr Chase");
  });

  test("rank is renumbered from the value actually stored", () => {
    const { entries } = parseMockAdp(payload, "ppr", 12);
    assert.deepEqual(
      entries.map((e) => e.rank),
      entries.map((_, i) => i + 1),
    );
    // Ascending ADP, so rank and adp cannot disagree.
    for (let i = 1; i < entries.length; i++) {
      assert.ok(entries[i].adp >= entries[i - 1].adp);
    }
  });

  test("the drafts it is averaged over come through", () => {
    const result = parseMockAdp(payload, "ppr", 12);
    assert.equal(result.totalDrafts, 1834);
    assert.equal(result.scoring, "ppr");
    assert.equal(result.teams, 12);
  });
});

describe("matching mock-draft ADP onto our players", () => {
  const players = [
    { id: "00-0001", full_name: "Ja'Marr Chase", position: "WR", team_abbr: "CIN" },
    { id: "00-0002", full_name: "Bijan Robinson", position: "RB", team_abbr: "ATL" },
    // Two people, one name. Only the team separates them.
    { id: "00-0003", full_name: "Michael Carter", position: "RB", team_abbr: "ARI" },
    { id: "00-0004", full_name: "Michael Carter", position: "RB", team_abbr: "NYJ" },
    // Same name, different position -- not a collision at all.
    { id: "00-0005", full_name: "Josh Allen", position: "QB", team_abbr: "BUF" },
    { id: "DST_BAL", full_name: "Baltimore Ravens", position: "DEF", team_abbr: "BAL" },
  ];

  function build(
    entries: { name: string; position: string; team: string; adp: number }[],
  ): MockAdpResult {
    return parseMockAdp(
      { status: "Success", meta: { total_drafts: 100 }, players: entries },
      "ppr",
      12,
    );
  }

  test("a plain name and position is enough", () => {
    const { rows } = matchMockAdp(
      build([{ name: "Ja'Marr Chase", position: "WR", team: "CIN", adp: 1.4 }]),
      players,
    );
    assert.deepEqual(rows, [
      { id: "00-0001", adp: 1.4, adp_rank: 1, adp_source: "mock-ppr" },
    ]);
  });

  test("two players of the same name are told apart by team", () => {
    const { rows } = matchMockAdp(
      build([{ name: "Michael Carter", position: "RB", team: "NYJ", adp: 140 }]),
      players,
    );
    assert.deepEqual(
      rows.map((r) => r.id),
      ["00-0004"],
    );
  });

  test("an ambiguous name with no team match is left alone, not guessed", () => {
    const { rows, unmatched } = matchMockAdp(
      build([{ name: "Michael Carter", position: "RB", team: "SEA", adp: 140 }]),
      players,
    );
    assert.deepEqual(rows, []);
    assert.deepEqual(unmatched, ["Michael Carter"]);
  });

  test("a defense is matched to its pseudo-player by team", () => {
    const { rows } = matchMockAdp(
      build([{ name: "Ravens", position: "DEF", team: "BAL", adp: 95.6 }]),
      players,
    );
    assert.deepEqual(
      rows.map((r) => r.id),
      ["DST_BAL"],
    );
  });

  test("somebody we have never heard of is counted, not invented", () => {
    const { rows, unmatched } = matchMockAdp(
      build([
        { name: "Ja'Marr Chase", position: "WR", team: "CIN", adp: 1.4 },
        { name: "Rookie Nobody", position: "WR", team: "LV", adp: 200 },
      ]),
      players,
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(unmatched, ["Rookie Nobody"]);
  });

  test("the same player twice is written once", () => {
    const { rows } = matchMockAdp(
      build([
        { name: "Ja'Marr Chase", position: "WR", team: "CIN", adp: 1.4 },
        { name: "JaMarr Chase", position: "WR", team: "CIN", adp: 1.6 },
      ]),
      players,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].adp, 1.4, "the earlier entry wins");
  });
});

describe("reading an injury", () => {
  const NOW = new Date("2026-09-10T00:00:00Z");

  test("a healthy player has nothing to say", () => {
    assert.equal(describeInjury({ injury_status: null }), null);
    assert.equal(describeInjury({ injury_status: "  " }), null);
  });

  test("injured reserve says how long, not just that he is hurt", () => {
    const injury = describeInjury({ injury_status: "IR" }, NOW);
    assert.equal(injury?.label, "IR");
    assert.equal(injury?.tone, "out");
    assert.match(injury!.outlook, /four games/);
  });

  test("questionable and out are not the same colour", () => {
    assert.equal(describeInjury({ injury_status: "Out" })?.tone, "out");
    assert.equal(
      describeInjury({ injury_status: "Questionable" })?.tone,
      "questionable",
    );
    assert.equal(
      describeInjury({ injury_status: "Doubtful" })?.tone,
      "doubtful",
    );
  });

  test("a designation nobody has a rule for still reads as English", () => {
    const injury = describeInjury({ injury_status: "COV" }, NOW);
    assert.equal(injury?.label, "COV");
    assert.equal(injury?.tone, "note");
    assert.match(injury!.outlook, /check the latest report/);
  });

  test("how long he has been hurt is added when the feed dated it", () => {
    const injury = describeInjury(
      {
        injury_status: "Out",
        injury_body_part: "hamstring",
        injury_start_date: "2026-08-01",
      },
      NOW,
    );
    assert.equal(injury?.bodyPart, "Hamstring");
    assert.match(injury!.outlook, /40 days/);
  });

  test("a fresh injury does not claim a duration it does not have", () => {
    const injury = describeInjury(
      { injury_status: "Questionable", injury_start_date: "2026-09-08" },
      NOW,
    );
    assert.equal(injury?.daysOut, 2);
    assert.doesNotMatch(injury!.outlook, /days now/);
  });
});

describe("dealing a roster into the lineup board", () => {
  const spots: LineupSpot[] = [
    { key: "QB-0", slotKey: "QB", label: "QB", isStarter: true, eligiblePositions: ["QB"] },
    { key: "RB-0", slotKey: "RB", label: "RB", isStarter: true, eligiblePositions: ["RB"] },
    { key: "RB-1", slotKey: "RB", label: "RB", isStarter: true, eligiblePositions: ["RB"] },
    { key: "FLEX-0", slotKey: "FLEX", label: "FLEX", isStarter: true, eligiblePositions: ["RB", "WR", "TE"] },
    { key: "BN-0", slotKey: "BN", label: "BN", isStarter: false, eligiblePositions: [] },
    { key: "BN-1", slotKey: "BN", label: "BN", isStarter: false, eligiblePositions: [] },
  ];

  const empty = Object.fromEntries(spots.map((s) => [s.key, null]));

  const player = (id: string, position: string, points: number) => ({
    playerId: id,
    points,
    player: { position },
  });

  test("everybody ends up somewhere", () => {
    const roster = [
      player("qb", "QB", 20),
      player("rb1", "RB", 18),
      player("rb2", "RB", 12),
      player("wr1", "WR", 15),
      player("te1", "TE", 5),
    ];

    const placed = autoFill(empty, spots, roster);
    const seated = new Set(Object.values(placed).filter(Boolean));

    assert.equal(seated.size, roster.length, "nobody left standing");
    assert.equal(placed["QB-0"], "qb");
  });

  test("starters are filled before the bench", () => {
    const roster = [player("qb", "QB", 20), player("rb1", "RB", 18)];
    const placed = autoFill(empty, spots, roster);

    assert.equal(placed["RB-0"], "rb1", "a back starts rather than sits");
    assert.equal(placed["BN-0"], null);
  });

  test("the better player takes the starting spot", () => {
    const roster = [player("rb1", "RB", 5), player("rb2", "RB", 22)];
    const placed = autoFill(empty, spots, roster);

    assert.equal(placed["RB-0"], "rb2");
    assert.equal(placed["RB-1"], "rb1");
  });

  test("nobody eligible for a slot is put in it", () => {
    const roster = [player("wr1", "WR", 15)];
    const placed = autoFill(empty, spots, roster);

    assert.equal(placed["QB-0"], null, "a receiver cannot start at QB");
    assert.equal(placed["RB-0"], null);
    assert.equal(placed["FLEX-0"], "wr1");
  });

  test("a lineup somebody has already set is not reshuffled", () => {
    const roster = [
      player("rb1", "RB", 30),
      player("rb2", "RB", 2),
      player("wr1", "WR", 9),
    ];

    // The manager has deliberately benched his best back.
    const chosen = { ...empty, "BN-0": "rb1", "RB-0": "rb2" };
    const placed = autoFill(chosen, spots, roster);

    assert.equal(placed["BN-0"], "rb1", "left where he was put");
    assert.equal(placed["RB-0"], "rb2");
    assert.equal(placed["FLEX-0"], "wr1", "only the gap was filled");
  });

  test("a roster bigger than the board leaves the surplus unplaced", () => {
    const roster = [
      player("qb", "QB", 20),
      player("rb1", "RB", 18),
      player("rb2", "RB", 12),
      player("wr1", "WR", 15),
      player("wr2", "WR", 11),
      player("wr3", "WR", 10),
      player("wr4", "WR", 9),
    ];

    const placed = autoFill(empty, spots, roster);
    const seated = new Set(Object.values(placed).filter(Boolean));

    assert.equal(seated.size, spots.length, "every spot taken");
    assert.equal(roster.length - seated.size, 1, "one player over capacity");
    // The one left out is the worst of them, not an arbitrary one.
    assert.ok(!seated.has("wr4"));
  });
});
