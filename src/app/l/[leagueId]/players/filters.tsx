"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { positionLabel, sortPositions } from "@/lib/roster-slots";

const AVAILABILITY = [
  { value: "available", label: "Free agents" },
  { value: "waivers", label: "On waivers" },
  { value: "rostered", label: "Rostered" },
  { value: "all", label: "Everyone" },
];

export function PlayerFilters({
  positions,
  nflTeams,
}: {
  positions: string[];
  nflTeams: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [search, setSearch] = useState(params.get("q") ?? "");
  const activePos = params.get("pos") ?? "";

  /** Any filter change resets to page 1 -- page 7 of a new filter is noise. */
  function update(changes: Record<string, string>) {
    const query = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value) query.set(key, value);
      else query.delete(key);
    }
    query.delete("page");
    router.push(`${pathname}?${query}`);
  }

  // Flex is not a position; it stands for whatever this league's flex
  // slots accept. Sorted in with the rest so the list reads QB, RB, WR,
  // TE, FLEX, D/ST, K... -- a lineup card's order, not alphabetical.
  const posOptions = sortPositions([...positions, "FLEX"]);

  return (
    <div className="space-y-3">
      {/*
        The search is the one control a thumb reaches for first, so on a
        phone it sticks to the top of the scroll with the position chips
        under it; from md it relaxes back into the filter card's flow.
        -mx-4/px-4 lets the sticky bar span the gutter the main column
        already pads (px-4), the same trick the wide tables use.
      */}
      <div className="sticky top-0 z-20 -mx-4 border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:static md:mx-0 md:border-0 md:bg-transparent md:p-0 md:backdrop-blur-none">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            update({ q: search.trim() });
          }}
          className="flex gap-2"
        >
          <input
            className="input"
            placeholder="Search players"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search players"
          />
          <button className="btn shrink-0">Search</button>
        </form>

        {/* Position as a horizontal chip rail on phones -- the one filter
            worth a tap rather than a menu. The rail scrolls inside itself,
            so the page never scrolls sideways. The full menu returns from
            md, alongside the other two selects. */}
        <div
          className="-mb-1 mt-3 flex gap-2 overflow-x-auto pb-1 md:hidden"
          role="group"
          aria-label="Filter by position"
        >
          <PosChip
            label="All"
            active={activePos === ""}
            onClick={() => update({ pos: "" })}
          />
          {posOptions.map((p) => (
            <PosChip
              key={p}
              label={p === "FLEX" ? "Flex" : positionLabel(p)}
              active={activePos === p}
              onClick={() => update({ pos: p })}
            />
          ))}
        </div>
      </div>

      <div className="card grid grid-cols-2 gap-3 md:grid-cols-3">
        <div>
          <label className="label" htmlFor="avail">
            Availability
          </label>
          <select
            id="avail"
            className="input"
            value={params.get("avail") ?? "available"}
            onChange={(e) => update({ avail: e.target.value })}
          >
            {AVAILABILITY.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </div>

        {/* On a phone the chip rail above already filters position, so the
            menu is desktop-only to avoid two controls for one filter. */}
        <div className="hidden md:block">
          <label className="label" htmlFor="pos">
            Position
          </label>
          <select
            id="pos"
            className="input"
            value={activePos}
            onChange={(e) => update({ pos: e.target.value })}
          >
            <option value="">All positions</option>
            {posOptions.map((p) => (
              <option key={p} value={p}>
                {p === "FLEX" ? "Flex eligible" : positionLabel(p)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label" htmlFor="team">
            NFL team
          </label>
          <select
            id="team"
            className="input"
            value={params.get("team") ?? ""}
            onChange={(e) => update({ team: e.target.value })}
          >
            <option value="">Every team</option>
            {nflTeams.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        <p className="muted col-span-2 hidden text-xs md:col-span-3 md:block">
          Sort by last week, average or season total using those headings.
        </p>
      </div>
    </div>
  );
}

/** One position in the mobile rail. 44px tall, so a thumb lands it. */
function PosChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex min-h-11 shrink-0 items-center rounded-full border px-4 text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
        active
          ? "border-transparent bg-accent text-accent-ink"
          : "border-border bg-surface-2 text-foreground hover:bg-border"
      }`}
    >
      {label}
    </button>
  );
}
