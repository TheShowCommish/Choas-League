"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { MobileNav, type MobileNavItem } from "./mobile-nav";
import { NavIcon, type NavIconName } from "./nav-icons";

interface NavItem {
  href: string;
  label: string;
  icon: NavIconName;
  /** Whether it has a tab of its own in the phone bar, or lives in More. */
  phoneTab?: boolean;
}

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

  return (
    <>
      {/* Phones: four tabs and a More sheet, within thumb reach. */}
      <MobileNav
        primary={phonePrimary}
        secondary={phoneSecondary}
        isActive={isActive}
      />

      {/*
        Wider screens: every section on the page at once, the way an ESPN or
        Yahoo user expects. A persistent band of tabs rather than a button
        that hides them -- one glance says where you are and one click gets
        anywhere else. The row scrolls sideways within itself on a narrow
        laptop rather than wrapping into a second band. The active tab is
        underlined in the accent, sitting on the header's own bottom edge.
      */}
      <nav aria-label="League sections" className="hidden md:block">
        <ul className="mx-auto -mb-px flex w-full max-w-5xl gap-1 overflow-x-auto px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {items.map((item) => {
            const active = isActive(item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`inline-flex min-h-10 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors focus-visible:rounded-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
                    active
                      ? "border-accent text-accent"
                      : "border-transparent text-muted hover:border-border hover:text-foreground"
                  }`}
                >
                  <NavIcon name={item.icon} className="size-4 shrink-0" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
