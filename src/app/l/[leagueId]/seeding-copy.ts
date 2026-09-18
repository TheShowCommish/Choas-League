import type { SeedingTiebreaker } from "@/lib/playoff-bracket";

/*
 * How the seeding tiebreakers are said, shared by the admin picker and
 * the standings page. Kept out of the "use client" setup parts so a
 * server component can read it: a value imported from a client module
 * reaches the server only as a reference, not as the object.
 */

/**
 * The seeding tiebreakers, in the order the picker offers them.
 *
 * The hints say exactly which way each one sorts, because "points
 * against" reads either way and a commissioner should not have to
 * guess.
 */
export const SEEDING_TIEBREAKER_COPY: Record<
  SeedingTiebreaker,
  {
    label: string;
    hint: string;
    /** The short form used in the "wins → losses → ..." order line. */
    short: string;
    /** Accepted and saved, but has nothing to read yet. */
    dormant?: boolean;
  }
> = {
  head_to_head: {
    label: "Head to head",
    short: "head-to-head",
    hint: "The team that won the meeting between them is seeded first.",
  },
  points_for: {
    label: "Points for",
    short: "points for",
    hint: "The team that scored more over the season is seeded first.",
  },
  points_against: {
    label: "Points against",
    short: "points against",
    hint: "The team that had more points scored against it is seeded first — the unluckiest schedule gets the edge.",
  },
  division_record: {
    label: "Division record",
    short: "division record",
    dormant: true,
    hint: "Best record inside its own division. Safe to set now: it sits idle until this league has divisions, and starts working the day it does.",
  },
  coin_flip: {
    label: "Coin flip",
    short: "coin flip",
    hint: "A repeatable flip: it lands the same way every time for a given league, season and team, so regenerating the bracket can't change it.",
  },
};

/**
 * The standings caption: which tiebreakers separate teams level on wins
 * and losses, in the league's order.
 *
 * division_record is skipped while the league has no divisions, because
 * seeding skips it too; saying it would promise a rule that never runs.
 * With nothing left to name, the database's fixed fallback order is what
 * decides, and the caption says so.
 */
export function seedingTiebreakCaption(
  tiebreakers: SeedingTiebreaker[],
  { hasDivisions = false }: { hasDivisions?: boolean } = {},
): string {
  const active = tiebreakers.filter(
    (key) => hasDivisions || key !== "division_record",
  );
  // A coin flip separates everyone, so nothing after it is ever reached.
  const flip = active.indexOf("coin_flip");
  const reached = flip === -1 ? active : active.slice(0, flip + 1);
  if (reached.length === 0) return "Ties broken by a fixed order.";
  const names = reached.map((key) =>
    key === "coin_flip" ? "a coin flip" : SEEDING_TIEBREAKER_COPY[key].short,
  );
  return `Ties broken by ${names.join(", then ")}.`;
}
