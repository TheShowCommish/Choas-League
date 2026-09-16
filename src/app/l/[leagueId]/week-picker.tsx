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

/**
 * The same choice as a row of buttons rather than a menu.
 *
 * A season is seventeen weeks, which is few enough to show all of them
 * and one fewer interaction than a select: no open, scan, pick. The row
 * scrolls sideways on a phone and the playoff weeks are separated off,
 * because "week 15" and "the semi-final" are different kinds of thing
 * to be looking for.
 */
export function WeekTabs({
  week,
  lastWeek,
  currentWeek,
  playoffStartWeek,
}: {
  week: number;
  lastWeek: number;
  currentWeek: number;
  /** The first week that is a playoff round, marked off from the rest. */
  playoffStartWeek: number;
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
    <div className="table-scroll">
      <div className="flex items-center gap-1" role="group" aria-label="Week">
        {/* The buttons are bare numbers so eighteen of them fit; this is
            what says what the numbers are. */}
        <span className="muted mr-1 shrink-0 text-xs tracking-wide uppercase">
          Week
        </span>
        {weeks.map((w) => (
          <span key={w} className="contents">
            {w === playoffStartWeek && w !== 1 && (
              <span
                aria-hidden
                className="mx-1 h-6 w-px shrink-0 bg-border"
              />
            )}
            <button
              type="button"
              onClick={() => go(w)}
              aria-current={w === week ? "page" : undefined}
              title={
                w === currentWeek
                  ? `Week ${w} -- the live week`
                  : w >= playoffStartWeek
                    ? `Week ${w} -- playoffs`
                    : `Week ${w}`
              }
              className={`min-h-9 shrink-0 rounded-md border px-2.5 text-sm whitespace-nowrap transition-colors ${
                w === week
                  ? "border-transparent bg-accent font-semibold text-accent-ink"
                  : "border-border bg-surface-2 text-muted hover:text-foreground"
              }`}
            >
              {w}
              {w === currentWeek && (
                <span
                  aria-hidden
                  className={`ml-1 inline-block size-1.5 rounded-full align-middle ${
                    w === week ? "bg-accent-ink" : "bg-accent"
                  }`}
                />
              )}
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
