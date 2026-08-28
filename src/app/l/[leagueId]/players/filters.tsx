"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

const AVAILABILITY = [
  { value: "available", label: "Free agents" },
  { value: "waivers", label: "On waivers" },
  { value: "rostered", label: "Rostered" },
  { value: "all", label: "Everyone" },
];

const SORTS = [
  { value: "points", label: "Season points" },
  { value: "last", label: "Last week" },
  { value: "average", label: "Average" },
  { value: "name", label: "Name" },
];

export function PlayerFilters({ positions }: { positions: string[] }) {
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
            {positions.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label" htmlFor="sort">
            Sort by
          </label>
          <select
            id="sort"
            className="input"
            value={params.get("sort") ?? "points"}
            onChange={(e) => update({ sort: e.target.value })}
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
