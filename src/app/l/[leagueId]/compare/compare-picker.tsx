"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { positionLabel } from "@/lib/roster-slots";
import { MAX_COMPARE, parsePlayerParam } from "@/lib/compare";

/** The little a player needs for a chip or a search result row. */
export interface PickerPlayer {
  id: string;
  name: string;
  position: string | null;
  teamAbbr: string | null;
}

/**
 * The compare picker: a search over the player pool plus the chips of who
 * is already being compared. Both the search box and the add / remove
 * controls drive the `players` (and `q`) query params; the server reloads
 * each player's numbers and the search results from there. Plainly styled
 * -- the designer owns the look.
 */
export function ComparePicker({
  selected,
  results,
}: {
  selected: PickerPlayer[];
  results: PickerPlayer[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [search, setSearch] = useState(params.get("q") ?? "");
  const query = params.get("q")?.trim() ?? "";
  const ids = parsePlayerParam(params.get("players") ?? undefined);
  const full = ids.length >= MAX_COMPARE;

  /** Rewrite the url with a new player list and/or search term. */
  function navigate(nextIds: string[], nextQuery?: string) {
    const next = new URLSearchParams(params);
    if (nextIds.length) next.set("players", nextIds.join(","));
    else next.delete("players");
    if (nextQuery === undefined) {
      // leave q as it is
    } else if (nextQuery) {
      next.set("q", nextQuery);
    } else {
      next.delete("q");
    }
    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  const add = (id: string) => {
    if (full || ids.includes(id)) return;
    navigate([...ids, id]);
  };
  const remove = (id: string) => navigate(ids.filter((x) => x !== id));

  const alreadyPicked = new Set(ids);
  const matches = results.filter((r) => !alreadyPicked.has(r.id));

  return (
    <div className="space-y-3">
      {selected.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-muted">Comparing</span>
            <span className="pill tabular-nums">
              {selected.length} of {MAX_COMPARE}
            </span>
          </div>
          <ul className="flex flex-wrap gap-2" aria-label="Selected players">
            {selected.map((p) => (
              <li
                key={p.id}
                className="inline-flex items-center gap-2 rounded-full border border-border bg-surface-2 py-1 pr-1 pl-3 text-sm"
              >
                <span className="font-medium">{p.name}</span>
                <span className="muted text-xs">
                  {positionLabel(p.position)}
                  {p.teamAbbr ? ` · ${p.teamAbbr}` : ""}
                </span>
                <button
                  type="button"
                  onClick={() => remove(p.id)}
                  aria-label={`Remove ${p.name}`}
                  className="inline-flex size-7 items-center justify-center rounded-full text-muted transition-colors hover:bg-border hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                >
                  <span aria-hidden className="text-lg leading-none">
                    &times;
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {full ? (
        <p className="note-neutral">
          <span>
            Comparing the maximum of {MAX_COMPARE} players. Remove one to swap
            in another.
          </span>
        </p>
      ) : (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              navigate(ids, search.trim());
            }}
            className="flex gap-2"
          >
            <input
              className="input"
              placeholder="Search players to compare"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search players to compare"
            />
            <button className="btn shrink-0">Search</button>
          </form>

          {query && (
            <ul className="card-tight divide-y divide-border/60 overflow-hidden">
              {matches.length === 0 ? (
                <li className="muted p-3 text-sm">
                  No other players match &ldquo;{query}&rdquo;.
                </li>
              ) : (
                matches.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center justify-between gap-3 p-2.5"
                  >
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate font-medium">{p.name}</span>
                      <span className="muted shrink-0 text-xs">
                        {positionLabel(p.position)}
                        {p.teamAbbr ? ` · ${p.teamAbbr}` : ""}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => add(p.id)}
                      className="btn btn-sm shrink-0"
                    >
                      Add
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
