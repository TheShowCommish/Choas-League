"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useLocalSetting, writeLocalSetting } from "@/lib/use-local-setting";

interface NavItem {
  href: string;
  label: string;
  /** Shorter label for the phone bar, where space is tight. */
  short: string;
}

/** Whether the desktop menu was left open. */
const STORAGE_KEY = "chaos-nav-open";
const OPEN_VALUES = ["0", "1"] as const;

export function LeagueNav({
  leagueId,
  isCommissioner,
  showDraft,
}: {
  leagueId: string;
  isCommissioner: boolean;
  showDraft: boolean;
}) {
  const pathname = usePathname();
  const base = `/l/${leagueId}`;

  const items: NavItem[] = [
    { href: base, label: "Home", short: "Home" },
    { href: `${base}/my-team`, label: "My Team", short: "Team" },
    { href: `${base}/matchups`, label: "Matchups", short: "Games" },
    { href: `${base}/players`, label: "Players", short: "Players" },
    { href: `${base}/trades`, label: "Trades", short: "Trades" },
    { href: `${base}/standings`, label: "Standings", short: "Table" },
    { href: `${base}/transactions`, label: "Transactions", short: "Log" },
    { href: `${base}/chat`, label: "Chat", short: "Chat" },
  ];

  if (showDraft) {
    items.splice(1, 0, { href: `${base}/draft`, label: "Draft", short: "Draft" });
  }
  if (isCommissioner) {
    items.push({ href: `${base}/admin`, label: "Admin", short: "Admin" });
  }

  const isActive = (href: string) =>
    href === base ? pathname === base : pathname.startsWith(href);

  /*
   * The desktop menu starts closed and remembers being opened.
   *
   * A row of ten tabs is a permanent band across the top of every page,
   * and on a laptop that band is a real fraction of what is left for
   * the standings table underneath it. Closed, the whole thing is one
   * button wearing the name of the page you are on.
   *
   * Closed is also what the server renders, so a menu somebody left open
   * unfolds on hydration rather than the other way round -- content
   * moving down the page is far less jarring than content snapping up.
   */
  const open = useLocalSetting(STORAGE_KEY, OPEN_VALUES, "0") === "1";

  function toggle() {
    writeLocalSetting(STORAGE_KEY, open ? "0" : "1");
  }

  const current = items.find((item) => isActive(item.href));

  return (
    <>
      {/* Phones: a fixed bar at the bottom, within thumb reach. */}
      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface md:hidden">
        <ul className="flex overflow-x-auto">
          {items.map((item) => (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                className={`flex min-h-14 min-w-16 items-center justify-center px-2 text-xs ${
                  isActive(item.href)
                    ? "border-t-2 border-accent text-accent"
                    : "text-muted"
                }`}
              >
                {item.short}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {/* Wider screens: one button that unfolds into the full menu. */}
      <nav className="mx-auto hidden w-full max-w-5xl px-4 pb-1 md:block">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls="league-menu"
          className="inline-flex min-h-9 items-center gap-2 rounded-md px-2 text-sm text-muted hover:text-foreground"
        >
          <span aria-hidden className="text-base leading-none">
            {open ? "\u00d7" : "\u2630"}
          </span>
          <span className="font-medium text-foreground">
            {current?.label ?? "Menu"}
          </span>
          <span className="muted text-xs">{open ? "Hide menu" : "Menu"}</span>
        </button>

        {open && (
          <ul id="league-menu" className="flex flex-wrap gap-1 pb-1">
            {items.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`inline-block border-b-2 px-3 py-2 text-sm whitespace-nowrap ${
                    isActive(item.href)
                      ? "border-accent text-accent"
                      : "border-transparent text-muted hover:text-foreground"
                  }`}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </nav>
    </>
  );
}
