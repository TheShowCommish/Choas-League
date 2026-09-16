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

    const index = free.findIndex((entry) =>
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
