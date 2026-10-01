/*
 * A relative import, not the "@/" alias: the tests run this file
 * straight through node, which resolves neither tsconfig paths nor a
 * missing extension.
 */
import { slotAccepts } from "./roster-slots.ts";

/*
 * Filling a lineup, as a pure function.
 *
 * Kept out of the editor component so it can be tested without a
 * browser, and out of lib/roster.ts so the editor -- a client component
 * -- can import it at all: lib/roster.ts is server-only.
 */

/** One individual spot on the board, as expandSlots produces them. */
export interface LineupSpot {
  key: string;
  slotKey: string;
  label: string;
  isStarter: boolean;
  eligiblePositions: string[];
}

/** As much of a rostered player as the filler needs to know. */
export interface Fillable {
  playerId: string;
  points: number;
  player: { position: string | null };
  /** His game has kicked off: he may not be dealt into a starting spot. */
  locked?: boolean;
}

/**
 * Deals every unplaced player into a spot he is eligible for.
 *
 * Starters first, and the best player first, because the two together
 * are the only sensible default: filling the bench ahead of the starting
 * lineup would leave a QB slot empty with a quarterback sitting behind
 * it. Whatever is already placed stays exactly where it is, so this
 * fills gaps rather than reshuffling a lineup somebody has set.
 *
 * A player nothing will take -- a sixth receiver in a league with five
 * places for one -- comes back unplaced. That is the roster being over
 * capacity rather than a bug, and the page says so.
 *
 * A locked player only ever goes to the bench: starting him would be a
 * lineup the server refuses.
 */
export function autoFill<T extends Fillable>(
  placed: Record<string, string | null>,
  spots: LineupSpot[],
  roster: T[],
): Record<string, string | null> {
  const next = { ...placed };
  const used = new Set(Object.values(next).filter((id): id is string => !!id));

  // Points are zero for a week not yet played, and the roster arrives in
  // position order, so ties fall back to that rather than to nothing.
  const free = roster
    .filter((entry) => !used.has(entry.playerId))
    .sort((a, b) => b.points - a.points);

  const order = [
    ...spots.filter((spot) => spot.isStarter),
    ...spots.filter((spot) => !spot.isStarter),
  ];

  for (const spot of order) {
    if (next[spot.key]) continue;

    const index = free.findIndex(
      (entry) =>
        !(spot.isStarter && entry.locked) &&
        slotAccepts(
          { eligible_positions: spot.eligiblePositions },
          entry.player.position,
        ),
    );
    if (index === -1) continue;

    next[spot.key] = free[index].playerId;
    free.splice(index, 1);
  }

  return next;
}

/** A roster slot, as much of one as saving a lineup needs. */
export interface SaveSlot {
  slot_key: string;
  count: number;
  is_starter: boolean;
  eligible_positions: string[];
}

export interface LineupSaveInput {
  week: number;
  lockMode: "per_player" | "weekly_kickoff";
  slots: SaveSlot[];
  /** player id -> slot key, for every lineup row this week. */
  current: Map<string, string>;
  /** Players whose place is locked (lineup_locks). */
  locked: Set<string>;
  /** The active roster: player id -> position. */
  roster: Map<string, string | null>;
  /** For messages. Falls back to "That player". */
  names: Map<string, string>;
  /**
   * player id -> slot key as the form sent it; "" means no slot. A
   * player missing altogether keeps his current slot if he is locked --
   * a disabled control is not submitted -- and is taken out otherwise.
   */
  submitted: Map<string, string>;
}

export type LineupSavePlan =
  | { error: string }
  | { upserts: { playerId: string; slotKey: string }[]; deletes: string[] };

/**
 * Works out what saving a lineup writes, or why it cannot.
 *
 * A locked player may not move into or out of a starting slot; moving
 * him around the bench is fine, and anything else about him the form
 * sent is ignored only if it is no change at all. The database enforces
 * the same rule (0042) -- this is here to give the reason in words and
 * to write only the rows that changed, so an unchanged locked starter
 * is never touched.
 */
export function planLineupSave(input: LineupSaveInput): LineupSavePlan {
  const { slots, current, locked, roster, names, submitted } = input;

  const slotOf = new Map(slots.map((s) => [s.slot_key, s]));
  const isStarter = (key: string) => !!key && slotOf.get(key)?.is_starter === true;
  const nameOf = (id: string) => names.get(id) ?? "That player";

  const everyone = new Set([...roster.keys(), ...current.keys()]);

  for (const [playerId, slotKey] of submitted) {
    if (slotKey && !everyone.has(playerId)) {
      return { error: "That player is not on your roster." };
    }
  }

  const final = new Map<string, string>();
  const unchangedLocked = new Set<string>();

  for (const playerId of everyone) {
    const was = current.get(playerId) ?? "";

    if (locked.has(playerId)) {
      const sent = submitted.has(playerId) ? submitted.get(playerId)! : was;
      if (sent !== was && (isStarter(was) || isStarter(sent))) {
        return { error: lockedMessage(input, nameOf(playerId), was, isStarter(was)) };
      }
      if (sent === was) unchangedLocked.add(playerId);
      final.set(playerId, sent);
      continue;
    }

    // Somebody no longer on the roster, and not locked in: cleared.
    if (!roster.has(playerId)) {
      final.set(playerId, "");
      continue;
    }

    final.set(playerId, submitted.get(playerId) ?? "");
  }

  // Validate before writing anything, so a bad lineup is rejected whole.
  const counts = new Map<string, number>();
  for (const [playerId, slotKey] of final) {
    if (!slotKey) continue;
    counts.set(slotKey, (counts.get(slotKey) ?? 0) + 1);

    // A locked player left where he was is not being chosen again.
    if (unchangedLocked.has(playerId)) continue;

    const slot = slotOf.get(slotKey);
    if (!slot) return { error: `Unknown roster slot "${slotKey}".` };

    if (!roster.has(playerId)) {
      return { error: "That player is not on your roster." };
    }

    const position = roster.get(playerId) ?? null;
    const eligible = slot.eligible_positions;
    if (eligible.length > 0 && (!position || !eligible.includes(position))) {
      return { error: `A ${position ?? "?"} cannot start at ${slotKey}.` };
    }
  }

  for (const slot of slots) {
    const used = counts.get(slot.slot_key) ?? 0;
    if (used > slot.count) {
      return {
        error: `Too many players at ${slot.slot_key}: ${used} of ${slot.count}.`,
      };
    }
  }

  const upserts: { playerId: string; slotKey: string }[] = [];
  const deletes: string[] = [];
  for (const [playerId, slotKey] of final) {
    const was = current.get(playerId) ?? "";
    if (slotKey === was) continue;
    if (slotKey) upserts.push({ playerId, slotKey });
    else if (current.has(playerId)) deletes.push(playerId);
  }

  return { upserts, deletes };
}

function lockedMessage(
  input: LineupSaveInput,
  name: string,
  was: string,
  wasStarter: boolean,
): string {
  const where = wasStarter
    ? `He has to stay at ${was}.`
    : "He cannot move into the starting lineup.";

  return input.lockMode === "weekly_kickoff"
    ? `${name} is locked: the first game of week ${input.week} has kicked off, so the lineup is locked. ${where}`
    : `${name} is locked: his week ${input.week} game has kicked off. ${where}`;
}

/** As much of an NFL game as working out a player's week needs. */
export interface WeekGame {
  home_team: string | null;
  away_team: string | null;
  kickoff_at: string | null;
}

/**
 * NFL team -> the game its week turns on, which is its earliest kickoff.
 *
 * Usually a team has exactly one game in a week, but a rescheduled or
 * doubled-up week can give it two, and the lock goes off the first of
 * them (player_week_kickoff in 0042). Taking the earliest here keeps the
 * kickoff a roster row shows next to the padlock the same one the lock
 * was worked out from. A game with no kickoff time yet loses to one that
 * has a time, and only stands in if nothing else does.
 */
export function earliestGameByTeam<T extends WeekGame>(games: T[]): Map<string, T> {
  const byTeam = new Map<string, T>();

  for (const game of games) {
    for (const abbr of [game.home_team, game.away_team]) {
      if (!abbr) continue;
      const had = byTeam.get(abbr);
      const better =
        !had ||
        (game.kickoff_at !== null &&
          (had.kickoff_at === null || game.kickoff_at < had.kickoff_at));
      if (better) byTeam.set(abbr, game);
    }
  }

  return byTeam;
}
