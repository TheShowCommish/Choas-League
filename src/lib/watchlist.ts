/**
 * Pure watchlist helpers (T-074): turning the owner / waiver signals the
 * server already has into the single availability a watchlist row shows.
 * No I/O here, so they are unit-tested directly (scripts/watchlist.test.ts).
 */
import type { WatchAvailability } from "@/lib/types";

/**
 * Where a watched player can be had. Owned beats waivers beats free agent:
 * a man on a roster is not up for grabs even if a stale waiver hold lingers.
 */
export function watchAvailability(
  ownerName: string | null,
  onWaivers: boolean,
): WatchAvailability {
  if (ownerName) return "owned";
  if (onWaivers) return "waivers";
  return "fa";
}

/** Short label for an availability, naming the owner when there is one. */
export function watchAvailabilityLabel(
  availability: WatchAvailability,
  ownerName: string | null,
): string {
  switch (availability) {
    case "owned":
      return ownerName ? `Rostered by ${ownerName}` : "Rostered";
    case "waivers":
      return "On waivers";
    case "fa":
      return "Free agent";
  }
}
