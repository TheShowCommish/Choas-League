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

  return (
    <div className="card space-y-3">
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
        <button className="btn">Search</button>
      </form>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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

        <div>
          <label className="label" htmlFor="pos">
            Position
          </label>
          <select
            id="pos"
            className="input"
            value={params.get("pos") ?? ""}
            onChange={(e) => update({ pos: e.target.value })}
          >
            <option value="">All positions</option>
            {/*
              Flex is not a position. It stands for whatever this
              league's flex slots accept, which the pool resolves per
              league rather than assuming RB/WR/TE. It is sorted in with
              the rest so the menu reads QB, RB, WR, TE, FLEX, D/ST, K,
              P, HC -- the order a lineup card does -- rather than
              alphabetically, or with flex bolted on the front.
            */}
            {sortPositions([...positions, "FLEX"]).map((p) => (
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
      </div>
      <p className="muted text-xs">
        Sort by last week, average or season total using those headings.
      </p>
    </div>
  );
}
