import type { RosterSlot } from "@/lib/types";

/*
 * Pure helpers for reasoning about roster slots. Kept apart from
 * lib/league.ts, which reaches for the server-only Supabase client and
 * so cannot be imported by a client component.
 */

/**
 * Expands roster_slots into the ordered list of individual lineup
 * positions -- a row of two RBs becomes RB and RB. This is the shape the
 * lineup editor and the matchup view both render.
 */
export function expandSlots(slots: RosterSlot[]) {
  return slots.flatMap((slot) =>
    Array.from({ length: slot.count }, (_, i) => ({
      key: `${slot.slot_key}-${i}`,
      slotKey: slot.slot_key,
      label: slot.label,
      isStarter: slot.is_starter,
      eligiblePositions: slot.eligible_positions,
    })),
  );
}

/** Can this player legally occupy this slot? An empty list means any. */
export function slotAccepts(
  slot: Pick<RosterSlot, "eligible_positions">,
  position: string | null,
): boolean {
  if (slot.eligible_positions.length === 0) return true;
  if (!position) return false;
  return slot.eligible_positions.includes(position);
}

/**
 * The one order positions are listed in, everywhere in the app: the
 * order a lineup card reads, which is also the order managers think in.
 *
 *   QB, RB, WR, TE, FLEX, D/ST, K, P, HC
 *
 * FB and OL are not on that list because most leagues never see them;
 * they sit next to the position they are a variant of rather than being
 * exiled to the end, which is where "unknown" goes.
 *
 * FLEX is not a position anybody plays -- it is whatever a league's flex
 * slots accept. It is in the order because the filter menus offer it
 * alongside the real ones, and it belongs after the positions it draws
 * from rather than alphabetically among them.
 *
 * Lives here rather than in lib/roster.ts so the draft room -- a client
 * component, and so unable to import anything server-only -- can sort
 * by it too. The two used to disagree, which is how the My Team summary
 * ended up alphabetical: DEF, K, QB, RB, TE, WR.
 */
export const POSITION_ORDER = [
  "QB", "RB", "FB", "WR", "TE", "FLEX", "DEF", "K", "P", "OL", "HC",
];

/**
 * What a position is called on screen. Only DEF differs: the table
 * stores the nflverse code, everyone else calls it a D/ST.
 */
export const POSITION_LABELS: Record<string, string> = {
  DEF: "D/ST",
  FLEX: "FLEX",
};

/** The on-screen name for a position code. */
export function positionLabel(position: string | null | undefined): string {
  if (!position) return "?";
  return POSITION_LABELS[position] ?? position;
}

/** Where a position sits in that order. Unknowns sort last. */
export function positionRank(position: string | null | undefined): number {
  const index = POSITION_ORDER.indexOf(position ?? "");
  return index === -1 ? POSITION_ORDER.length : index;
}

/** Sorts positions into POSITION_ORDER, unknowns alphabetically at the end. */
export function byPosition(a: string, b: string): number {
  return positionRank(a) - positionRank(b) || a.localeCompare(b);
}

/**
 * The positions a league can roster, in POSITION_ORDER. The source list
 * arrives from the database alphabetically and from feature code in
 * whatever order it was written in; this is the single place that fixes
 * that, so every menu agrees.
 */
export function sortPositions(positions: readonly string[]): string[] {
  return [...positions].sort(byPosition);
}
