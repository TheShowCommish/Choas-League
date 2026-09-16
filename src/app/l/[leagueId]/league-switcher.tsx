"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export interface LeagueOption {
  id: string;
  name: string;
  season: number;
  isCommissioner: boolean;
}

/**
 * Hops between the leagues you are in.
 *
 * Being in two leagues used to mean signing out and back in, because
 * the only list of them was behind /leagues and the header offered no
 * way back. The league name in the header is now the way there: it
 * names where you are, and opens onto everywhere else you could be.
 *
 * A manager in exactly one league gets a plain heading -- a menu with a
 * single entry is a menu that wastes a tap.
 */
export function LeagueSwitcher({
  current,
  leagues,
}: {
  current: LeagueOption;
  leagues: LeagueOption[];
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Close on a click anywhere else, and on Escape -- the two things
  // every menu is expected to do and neither of which is free.
  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (leagues.length < 2) {
    return (
      <Link href={`/l/${current.id}`} className="block truncate font-semibold">
        {current.name}
      </Link>
    );
  }

  return (
    <div className="relative min-w-0" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex w-full min-w-0 items-center gap-1.5 text-left font-semibold hover:text-accent"
      >
        <span className="truncate">{current.name}</span>
        <span aria-hidden className="shrink-0 text-xs text-muted">
          &#9662;
        </span>
      </button>

      {open && (
        <ul
          role="menu"
          className="absolute top-full left-0 z-30 mt-1 max-h-80 w-64 overflow-y-auto rounded-md border border-border bg-surface py-1 shadow-lg"
        >
          {leagues.map((league) => (
            <li key={league.id} role="none">
              <Link
                role="menuitem"
                href={`/l/${league.id}`}
                onClick={() => setOpen(false)}
                className={`flex items-baseline justify-between gap-2 px-3 py-2 text-sm hover:bg-surface-2 ${
                  league.id === current.id ? "text-accent" : ""
                }`}
              >
                <span className="min-w-0 truncate">{league.name}</span>
                <span className="muted shrink-0 text-xs">
                  {league.season}
                  {league.isCommissioner && " \u00b7 commish"}
                </span>
              </Link>
            </li>
          ))}

          <li role="none" className="mt-1 border-t border-border pt-1">
            <Link
              role="menuitem"
              href="/leagues"
              onClick={() => setOpen(false)}
              className="block px-3 py-2 text-sm text-muted hover:bg-surface-2 hover:text-foreground"
            >
              All leagues &mdash; join or create
            </Link>
          </li>
        </ul>
      )}
    </div>
  );
}
