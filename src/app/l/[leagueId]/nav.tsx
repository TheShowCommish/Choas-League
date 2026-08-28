"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavItem {
  href: string;
  label: string;
  /** Shorter label for the phone bar, where space is tight. */
  short: string;
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
    { href: base, label: "Home", short: "Home" },
    { href: `${base}/my-team`, label: "My Team", short: "Team" },
    { href: `${base}/matchups`, label: "Matchups", short: "Games" },
    { href: `${base}/players`, label: "Players", short: "Players" },
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

      {/* Wider screens: a normal horizontal nav under the header. */}
      <nav className="mx-auto hidden w-full max-w-5xl px-4 md:block">
        <ul className="flex gap-1 overflow-x-auto">
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
      </nav>
    </>
  );
}
