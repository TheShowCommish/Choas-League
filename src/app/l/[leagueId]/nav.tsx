"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useLocalSetting, writeLocalSetting } from "@/lib/use-local-setting";
import { MobileNav, type MobileNavItem } from "./mobile-nav";
import type { NavIconName } from "./nav-icons";

interface NavItem {
  href: string;
  label: string;
  icon: NavIconName;
  /** Whether it has a tab of its own in the phone bar, or lives in More. */
  phoneTab?: boolean;
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
    { href: base, label: "Home", icon: "home", phoneTab: true },
    { href: `${base}/my-team`, label: "My Team", icon: "team", phoneTab: true },
    { href: `${base}/matchups`, label: "Matchups", icon: "matchups", phoneTab: true },
    { href: `${base}/players`, label: "Players", icon: "players", phoneTab: true },
    { href: `${base}/trades`, label: "Trades", icon: "trades" },
    { href: `${base}/standings`, label: "Standings", icon: "standings" },
    { href: `${base}/transactions`, label: "Transactions", icon: "log" },
    { href: `${base}/chat`, label: "Chat", icon: "chat" },
  ];

  if (showDraft) {
    items.splice(1, 0, { href: `${base}/draft`, label: "Draft", icon: "draft" });
  }
  if (isCommissioner) {
    items.push({ href: `${base}/admin`, label: "Admin", icon: "admin" });
  }

  // The phone bar says "Team" -- "My Team" does not fit a fifth of 320px.
  const toPhone = (item: NavItem): MobileNavItem => ({
    href: item.href,
    label: item.label === "My Team" ? "Team" : item.label,
    icon: item.icon,
  });
  const phonePrimary = items.filter((item) => item.phoneTab).map(toPhone);
  // Draft sits first in More when it is showing: on draft day it is the
  // one place everybody is heading. Otherwise the desktop order holds.
  const phoneSecondary = items.filter((item) => !item.phoneTab).map(toPhone);

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
      {/* Phones: four tabs and a More sheet, within thumb reach. */}
      <MobileNav
        primary={phonePrimary}
        secondary={phoneSecondary}
        isActive={isActive}
      />

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
