// Relative, with the .ts the runtime wants: this helper is unit-tested
// under `node --test`, which resolves neither the `@/` tsconfig alias nor
// an extensionless specifier. describeInjury is pure; expandSlots pulls in
// only an erased `import type`, so the module stays loadable there.
import { describeInjury, type InjuryFields } from "./injury.ts";
import { expandSlots } from "./roster-slots.ts";
import type { RosterEntry } from "./roster.ts";
import type { RosterSlot } from "./types.ts";

/**
 * Roster-health alerts (T-075): catching a broken starting lineup before
 * kickoff, the way ESPN and Yahoo nudge a manager on a Sunday morning.
 *
 * Three things a manager can still fix are worth a nudge: a starting slot
 * with nobody in it, a starter on a bye (his NFL team isn't playing that
 * week), and a starter who is ruled out. Everything here is pure, so the
 * server pages and the unit test share one notion of "this lineup has a
 * problem".
 *
 * "Ruled out" means an inactive-type designation -- the same ones
 * describeInjury already paints as `tone: "out"`: OUT, IR, PUP, NFI,
 * suspended, did-not-report. Questionable and Doubtful are deliberately
 * NOT flagged: he is probably playing, and crying wolf on every
 * Questionable is how a banner gets ignored.
 */

export type LineupIssueKind = "empty" | "bye" | "injury";

/** One problem with one starting slot, ready for a banner to list. */
export interface LineupIssue {
  kind: LineupIssueKind;
  /** The slot's label -- "QB", "FLEX", "D/ST". */
  slotLabel: string;
  /** The starter's name; null for an empty slot. */
  playerName: string | null;
  /** The injury designation for an "injury" issue, else null. */
  detail: string | null;
}

/** One starting slot, reduced to what the health check turns on. */
export interface StarterHealthInput {
  slotLabel: string;
  /** null when no player is assigned to this starting slot. */
  player: {
    name: string;
    /** His NFL team has no game this week (RosterEntry.game === null). */
    onBye: boolean;
    injury: InjuryFields;
  } | null;
  /**
   * He can no longer be moved into or out of the lineup this week (his
   * game has kicked off, or the league locked the lineup). A locked
   * problem can't be fixed, so it isn't worth a nudge.
   */
  locked: boolean;
}

export interface LineupHealth {
  /** Every problem found, slot order preserved. */
  issues: LineupIssue[];
  /** issues.length, for a badge count without walking the array. */
  count: number;
}

/**
 * Walk the starting slots and collect what a manager can still act on.
 *
 * A locked slot is skipped whatever its state: nothing can be done about
 * it, so nagging would only train the manager to ignore the banner. One
 * issue per slot, in precedence order empty > bye > injury -- a bye
 * starter who is also hurt reads as a bye, because he isn't playing
 * either way.
 */
export function lineupHealth(starters: StarterHealthInput[]): LineupHealth {
  const issues: LineupIssue[] = [];

  for (const s of starters) {
    if (s.locked) continue;

    if (!s.player) {
      issues.push({
        kind: "empty",
        slotLabel: s.slotLabel,
        playerName: null,
        detail: null,
      });
      continue;
    }

    if (s.player.onBye) {
      issues.push({
        kind: "bye",
        slotLabel: s.slotLabel,
        playerName: s.player.name,
        detail: null,
      });
      continue;
    }

    const injury = describeInjury(s.player.injury);
    if (injury && injury.tone === "out") {
      issues.push({
        kind: "injury",
        slotLabel: s.slotLabel,
        playerName: s.player.name,
        detail: injury.label,
      });
    }
  }

  return { issues, count: issues.length };
}

/**
 * Reduce a loaded roster + the league's slots to the starting slots the
 * health check reasons over.
 *
 * Mirrors the lineup editor's own seeding: starting spots are expanded in
 * order, and each saved starter is dealt into the next spot for his slot;
 * a spot with nobody left for it is an empty starting slot. Pure, so both
 * My Team and Home build the same picture.
 */
export function startersFromRoster(
  roster: RosterEntry[],
  slots: RosterSlot[],
): StarterHealthInput[] {
  const spots = expandSlots(slots).filter((spot) => spot.isStarter);

  // player ids waiting to be dealt into each starting slot key.
  const bySlot = new Map<string, RosterEntry[]>();
  for (const entry of roster) {
    if (!entry.slotKey) continue;
    const list = bySlot.get(entry.slotKey) ?? [];
    list.push(entry);
    bySlot.set(entry.slotKey, list);
  }

  return spots.map((spot) => {
    const entry = bySlot.get(spot.slotKey)?.shift();
    if (!entry) {
      return { slotLabel: spot.label, player: null, locked: false };
    }
    return {
      slotLabel: spot.label,
      player: {
        name: entry.player.full_name,
        onBye: entry.game === null,
        injury: entry.player,
      },
      locked: entry.locked,
    };
  });
}
