/**
 * Lineup / roster-health alerts (T-075).
 *
 *   npm test
 *
 * lineupHealth walks a week's starting slots and reports what a manager
 * can still fix before kickoff. The contract these fixtures pin:
 *
 *   - an empty starting slot is flagged;
 *   - a starter on a bye (no NFL game that week) is flagged;
 *   - a starter with an inactive-type designation (OUT, IR, ...) is
 *     flagged, but Questionable / Doubtful are NOT -- he is probably
 *     playing, and a banner that cries wolf gets ignored;
 *   - a healthy, full lineup returns no issues;
 *   - a locked slot is skipped whatever its state, so a finished or
 *     kicked-off week does not nag.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  lineupHealth,
  startersFromRoster,
  type StarterHealthInput,
} from "../src/lib/roster-health.ts";
import type { RosterEntry } from "../src/lib/roster.ts";
import type { NflGame, NflPlayer, RosterSlot } from "../src/lib/types.ts";

/** A healthy starter in `slot`, playing this week, no injury. */
function ok(slot: string): StarterHealthInput {
  return {
    slotLabel: slot,
    player: { name: `${slot} Guy`, onBye: false, injury: { injury_status: null } },
    locked: false,
  };
}

/** An empty starting slot. */
function empty(slot: string): StarterHealthInput {
  return { slotLabel: slot, player: null, locked: false };
}

/** A starter in `slot` on a bye. */
function onBye(slot: string): StarterHealthInput {
  return {
    slotLabel: slot,
    player: { name: `${slot} Guy`, onBye: true, injury: { injury_status: null } },
    locked: false,
  };
}

/** A starter in `slot` carrying an injury designation. */
function injured(slot: string, status: string): StarterHealthInput {
  return {
    slotLabel: slot,
    player: {
      name: `${slot} Guy`,
      onBye: false,
      injury: { injury_status: status },
    },
    locked: false,
  };
}

describe("lineupHealth", () => {
  test("a full, healthy lineup has nothing to flag", () => {
    const health = lineupHealth([ok("QB"), ok("RB"), ok("WR"), ok("D/ST")]);
    assert.equal(health.count, 0);
    assert.deepEqual(health.issues, []);
  });

  test("an empty starting slot is flagged", () => {
    const health = lineupHealth([ok("QB"), empty("RB"), ok("WR")]);
    assert.equal(health.count, 1);
    assert.deepEqual(health.issues[0], {
      kind: "empty",
      slotLabel: "RB",
      playerName: null,
      detail: null,
    });
  });

  test("a starter on a bye is flagged", () => {
    const health = lineupHealth([ok("QB"), onBye("WR")]);
    assert.equal(health.count, 1);
    assert.equal(health.issues[0].kind, "bye");
    assert.equal(health.issues[0].slotLabel, "WR");
    assert.equal(health.issues[0].playerName, "WR Guy");
  });

  test("an OUT / IR starter is flagged, with the designation", () => {
    const out = lineupHealth([injured("QB", "Out")]);
    assert.equal(out.count, 1);
    assert.equal(out.issues[0].kind, "injury");
    assert.equal(out.issues[0].detail, "OUT");

    const ir = lineupHealth([injured("RB", "IR")]);
    assert.equal(ir.count, 1);
    assert.equal(ir.issues[0].detail, "IR");
  });

  test("Questionable and Doubtful are not flagged", () => {
    const health = lineupHealth([
      injured("QB", "Questionable"),
      injured("RB", "Doubtful"),
    ]);
    assert.equal(health.count, 0);
  });

  test("a locked slot is skipped, however broken", () => {
    // Empty, bye and OUT -- all locked, so none can be changed and none
    // should nag.
    const health = lineupHealth([
      { slotLabel: "QB", player: null, locked: true },
      {
        slotLabel: "WR",
        player: { name: "Bye Guy", onBye: true, injury: { injury_status: null } },
        locked: true,
      },
      {
        slotLabel: "RB",
        player: { name: "Hurt Guy", onBye: false, injury: { injury_status: "Out" } },
        locked: true,
      },
    ]);
    assert.equal(health.count, 0);
  });

  test("a bye starter who is also hurt reads as a bye", () => {
    const health = lineupHealth([
      {
        slotLabel: "WR",
        player: { name: "WR Guy", onBye: true, injury: { injury_status: "Out" } },
        locked: false,
      },
    ]);
    assert.equal(health.count, 1);
    assert.equal(health.issues[0].kind, "bye");
  });

  test("several problems are all reported, in slot order", () => {
    const health = lineupHealth([
      ok("QB"),
      empty("RB"),
      onBye("WR"),
      injured("TE", "IR"),
      ok("K"),
    ]);
    assert.equal(health.count, 3);
    assert.deepEqual(
      health.issues.map((i) => i.kind),
      ["empty", "bye", "injury"],
    );
  });
});

// startersFromRoster: the step that feeds lineupHealth. It mirrors the
// lineup editor's own seeding -- starting spots expanded in order, each
// saved starter dealt into the next spot for its slot -- so the banner
// and the editor agree about what is in each starting slot.

/** One starting slot the league rosters. */
function starterSlot(slotKey: string, count: number): RosterSlot {
  return {
    id: slotKey,
    league_id: "l",
    slot_key: slotKey,
    label: slotKey,
    eligible_positions: [],
    count,
    is_starter: true,
    order_index: 0,
  };
}

/** A bench slot. */
function benchSlot(count: number): RosterSlot {
  return {
    id: "BN",
    league_id: "l",
    slot_key: "BN",
    label: "Bench",
    eligible_positions: [],
    count,
    is_starter: false,
    order_index: 90,
  };
}

/** A rostered player, reduced to the fields startersFromRoster reads. */
function entry(opts: {
  name: string;
  slotKey: string | null;
  onBye?: boolean;
  injuryStatus?: string | null;
  locked?: boolean;
}): RosterEntry {
  return {
    playerId: opts.name,
    player: {
      full_name: opts.name,
      injury_status: opts.injuryStatus ?? null,
    } as unknown as NflPlayer,
    slotKey: opts.slotKey,
    locked: opts.locked ?? false,
    onRoster: true,
    points: 0,
    isFinal: false,
    breakdown: {},
    game: opts.onBye ? null : ({ id: "G1" } as unknown as NflGame),
    opponent: null,
    acquiredVia: "draft",
  };
}

describe("startersFromRoster", () => {
  test("saved starters are dealt into matching starter spots, in order", () => {
    const starters = startersFromRoster(
      [
        entry({ name: "The RB", slotKey: "RB" }),
        entry({ name: "The QB", slotKey: "QB" }),
      ],
      [starterSlot("QB", 1), starterSlot("RB", 1)],
    );
    assert.deepEqual(
      starters.map((s) => [s.slotLabel, s.player?.name]),
      [
        ["QB", "The QB"],
        ["RB", "The RB"],
      ],
    );
  });

  test("a starter slot with no saved entry comes back empty", () => {
    const starters = startersFromRoster(
      [entry({ name: "The QB", slotKey: "QB" })],
      [starterSlot("QB", 1), starterSlot("RB", 1)],
    );
    assert.equal(starters.length, 2);
    assert.equal(starters[1].slotLabel, "RB");
    assert.equal(starters[1].player, null);
  });

  test("bench-slot entries are not counted as starters", () => {
    const starters = startersFromRoster(
      [
        entry({ name: "The QB", slotKey: "QB" }),
        entry({ name: "Benched Guy", slotKey: "BN" }),
      ],
      [starterSlot("QB", 1), benchSlot(5)],
    );
    assert.equal(starters.length, 1);
    assert.equal(starters[0].slotLabel, "QB");
    assert.equal(starters[0].player?.name, "The QB");
  });

  test("two saved entries for a multi-count slot fill successive spots", () => {
    const starters = startersFromRoster(
      [
        entry({ name: "WR One", slotKey: "WR" }),
        entry({ name: "WR Two", slotKey: "WR" }),
      ],
      [starterSlot("WR", 2)],
    );
    assert.deepEqual(
      starters.map((s) => s.player?.name),
      ["WR One", "WR Two"],
    );
  });

  test("a null game reads as a bye, and locked is carried through", () => {
    const starters = startersFromRoster(
      [entry({ name: "Bye QB", slotKey: "QB", onBye: true, locked: true })],
      [starterSlot("QB", 1)],
    );
    assert.equal(starters[0].player?.onBye, true);
    assert.equal(starters[0].locked, true);
  });
});
