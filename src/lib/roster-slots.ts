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
