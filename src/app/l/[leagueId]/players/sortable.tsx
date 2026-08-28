"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * A column heading that sorts.
 *
 * Sorting is a round trip because the table is a page of fifty out of
 * several thousand: sorting what happens to be on screen would sort the
 * wrong set. Clicking the active column flips direction.
 */
export function SortHeader({
  column,
  label,
  defaultDir = "desc",
  className = "",
}: {
  column: string;
  label: string;
  /** Which way round the first click sorts. Names read better a-z. */
  defaultDir?: "asc" | "desc";
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const active = (params.get("sort") ?? "points") === column;
  const dir = active ? (params.get("dir") ?? "desc") : null;

  function toggle() {
    const query = new URLSearchParams(params);
    query.set("sort", column);
    query.set("dir", active && dir === defaultDir ? flip(defaultDir) : defaultDir);
    query.delete("page");
    router.push(`${pathname}?${query}`);
  }

  return (
    <th className={className} aria-sort={ariaSort(active, dir)}>
      <button
        type="button"
        onClick={toggle}
        className={`inline-flex items-center gap-1 hover:text-accent ${
          active ? "text-accent" : ""
        }`}
      >
        {label}
        <span aria-hidden className="text-xs">
          {active ? (dir === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
}

function flip(dir: "asc" | "desc"): "asc" | "desc" {
  return dir === "asc" ? "desc" : "asc";
}

function ariaSort(
  active: boolean,
  dir: string | null,
): "ascending" | "descending" | "none" {
  if (!active) return "none";
  return dir === "asc" ? "ascending" : "descending";
}
