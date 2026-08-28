"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Week selector shared by the roster, matchup and scoring views. Writes
 * the choice to ?week= so the page stays linkable and the server
 * component re-renders with the new week.
 */
export function WeekPicker({
  week,
  lastWeek,
  currentWeek,
}: {
  week: number;
  lastWeek: number;
  /** The league's live week, marked so it is easy to get back to. */
  currentWeek: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const weeks = Array.from({ length: lastWeek }, (_, i) => i + 1);

  function go(next: number) {
    const query = new URLSearchParams(params);
    query.set("week", String(next));
    router.push(`${pathname}?${query}`);
  }

  return (
    <div className="flex items-center gap-2">
      <button
        className="btn btn-sm"
        onClick={() => go(week - 1)}
        disabled={week <= 1}
        aria-label="Previous week"
      >
        &larr;
      </button>

      <select
        aria-label="Week"
        className="input w-32"
        value={week}
        onChange={(e) => go(Number(e.target.value))}
      >
        {weeks.map((w) => (
          <option key={w} value={w}>
            Week {w}
            {w === currentWeek ? " (now)" : ""}
          </option>
        ))}
      </select>

      <button
        className="btn btn-sm"
        onClick={() => go(week + 1)}
        disabled={week >= lastWeek}
        aria-label="Next week"
      >
        &rarr;
      </button>
    </div>
  );
}
