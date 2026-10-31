"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { MobileNav, type MobileNavItem } from "./mobile-nav";
import { NavIcon, type NavIconName } from "./nav-icons";

// useLayoutEffect warns when run on the server; the measurement it does
// only means anything in the browser, so fall back to useEffect there.
const useIsoLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

// The box shape every desktop tab (and the More trigger) shares. Colour and
// interaction classes are layered on per use; only the shape sets the width,
// so the hidden measuring row below can reuse this verbatim.
const TAB_SHAPE =
  "inline-flex min-h-10 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-sm font-medium";

// The flex `gap-1` between tabs, in px -- the measurer accounts for it by hand
// since a child's offsetWidth does not include the gap beside it.
const TAB_GAP = 4;

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
    { href: `${base}/watchlist`, label: "Watchlist", icon: "watch" },
    { href: `${base}/trades`, label: "Trades", icon: "trades" },
    { href: `${base}/standings`, label: "Standings", icon: "standings" },
    { href: `${base}/awards`, label: "Awards", icon: "awards" },
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
        anywhere else. The active tab is underlined in the accent, sitting on
        the header's own bottom edge.

        The band is capped at the header's width, so once the full set grew to
        a dozen tabs the trailing ones -- Admin above all -- ran off the right
        edge with no cue they were there. Rather than a silent sideways scroll,
        whatever will not fit collapses into a "More" menu at the end of the
        row (the desktop echo of the phone's More sheet): nothing is ever
        clipped, and a commissioner is always one click from Admin.
      */}
      <DesktopNav items={items} isActive={isActive} />
    </>
  );
}

/**
 * The desktop tab band with an adaptive overflow menu.
 *
 * A hidden copy of the full row is measured against the available width; the
 * tabs that fit stay in the band and the rest move into a "More" dropdown. The
 * split recomputes on resize, so the band neither wraps nor scrolls -- it just
 * shows what it can and parks the overflow one click away. When the active
 * page is one of the parked tabs, the trigger wears the accent too, so you can
 * still tell at a glance that you are "in there".
 */
function DesktopNav({
  items,
  isActive,
}: {
  items: NavItem[];
  isActive: (href: string) => boolean;
}) {
  const pathname = usePathname();
  const rowRef = useRef<HTMLUListElement>(null);
  const ghostRef = useRef<HTMLUListElement>(null);

  // Start with the whole set: it matches the server render (so hydration is
  // clean and every link ships in the HTML), then the first layout pass trims
  // it to fit before the browser paints.
  const [visibleCount, setVisibleCount] = useState(items.length);
  // Until the first measure, the server HTML clips any overflow so it can
  // never widen the page; once mounted the row shows overflow so the dropdown
  // can escape the band.
  const [measured, setMeasured] = useState(false);

  useIsoLayoutEffect(() => {
    const row = rowRef.current;
    const ghost = ghostRef.current;
    if (!row || !ghost) return;

    function measure() {
      if (!row || !ghost) return;
      const available = row.clientWidth;
      // The ghost is the full set of tabs followed by the More trigger.
      const kids = Array.from(ghost.children) as HTMLElement[];
      const moreWidth = kids[kids.length - 1]?.offsetWidth ?? 0;
      const widths = kids.slice(0, items.length).map((el) => el.offsetWidth);

      const totalAll = widths.reduce((sum, w) => sum + w + TAB_GAP, 0) - TAB_GAP;
      if (totalAll <= available) {
        setVisibleCount(items.length);
        return;
      }

      // Overflow: reserve room for the More trigger, then take as many tabs as
      // fit. Never drop to zero -- at least the first tab stays put.
      let used = moreWidth + TAB_GAP;
      let count = 0;
      for (const w of widths) {
        const next = used + w + TAB_GAP;
        if (next > available) break;
        used = next;
        count += 1;
      }
      setVisibleCount(Math.max(1, count));
    }

    measure();
    setMeasured(true);
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
    // Re-run when the set itself changes (draft/admin toggles the count).
  }, [items.length]);

  const count = Math.min(visibleCount, items.length);
  const visibleItems = items.slice(0, count);
  const overflowItems = items.slice(count);

  return (
    <nav aria-label="League sections" className="hidden md:block">
      <div className="mx-auto w-full max-w-5xl px-2">
        <div className="relative">
          {/* The measuring row: the full set at full size, laid out but never
              shown, read only for its widths. */}
          <ul
            ref={ghostRef}
            aria-hidden="true"
            className="pointer-events-none invisible absolute top-0 left-0 -mb-px flex gap-1"
          >
            {items.map((item) => (
              <li key={item.href}>
                <span className={`${TAB_SHAPE} border-transparent`}>
                  <NavIcon name={item.icon} className="size-4 shrink-0" />
                  {item.label}
                </span>
              </li>
            ))}
            <li>
              <span className={`${TAB_SHAPE} border-transparent`}>
                <NavIcon name="more" className="size-4 shrink-0" />
                More
                <Chevron />
              </span>
            </li>
          </ul>

          {/* The real row. Before the first measure it clips so the full set
              can never push the page sideways; after, it lets the dropdown
              overflow the band. */}
          <ul
            ref={rowRef}
            className={`-mb-px flex gap-1 ${
              measured ? "overflow-visible" : "overflow-hidden"
            }`}
          >
            {visibleItems.map((item) => {
              const active = isActive(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`${TAB_SHAPE} transition-colors focus-visible:rounded-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
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

            {overflowItems.length > 0 && (
              <OverflowMenu
                items={overflowItems}
                isActive={isActive}
                pathname={pathname}
              />
            )}
          </ul>
        </div>
      </div>
    </nav>
  );
}

/**
 * The "More" trigger and its dropdown, holding the tabs that did not fit.
 *
 * A menu-button: the trigger carries aria-haspopup/aria-expanded and owns the
 * menu by id; the items are menuitems reached with the arrow keys, Home/End or
 * the Tab key. Escape and a click outside close it, and Escape hands focus
 * back to the trigger. Opening it moves focus to the first item.
 */
function OverflowMenu({
  items,
  isActive,
  pathname,
}: {
  items: NavItem[];
  isActive: (href: string) => boolean;
  pathname: string;
}) {
  // The menu is open *for a page*, the way the phone sheet is: navigating
  // anywhere changes the pathname and the menu derives closed with no effect
  // to fire. (And widening the window until nothing overflows unmounts this
  // whole component, which closes it too.) That keeps setState out of effects.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const close = () => setOpenOn(null);

  const wrapRef = useRef<HTMLLIElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const menuId = useId();

  const activeInMore = items.find((item) => isActive(item.href));

  // Move focus into the menu when it opens, so the keyboard lands somewhere.
  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  // A click anywhere outside closes it.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        close();
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const focusItem = (index: number) => {
    const n = items.length;
    const wrapped = ((index % n) + n) % n;
    itemRefs.current[wrapped]?.focus();
  };

  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpenOn(pathname);
    }
  };

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    const current = itemRefs.current.findIndex(
      (el) => el === document.activeElement,
    );
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        close();
        triggerRef.current?.focus();
        break;
      case "ArrowDown":
        event.preventDefault();
        focusItem(current + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusItem(current - 1);
        break;
      case "Home":
        event.preventDefault();
        focusItem(0);
        break;
      case "End":
        event.preventDefault();
        focusItem(items.length - 1);
        break;
      case "Tab":
        // Let focus leave naturally, but do not leave the menu hanging open.
        close();
        break;
    }
  };

  return (
    <li ref={wrapRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpenOn(open ? null : pathname)}
        onKeyDown={onTriggerKeyDown}
        className={`${TAB_SHAPE} transition-colors focus-visible:rounded-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
          activeInMore
            ? "border-accent text-accent"
            : "border-transparent text-muted hover:border-border hover:text-foreground"
        }`}
      >
        <NavIcon name="more" className="size-4 shrink-0" />
        More
        <Chevron open={open} />
        {activeInMore && (
          <span className="sr-only">, current page: {activeInMore.label}</span>
        )}
      </button>

      {open && (
        <ul
          id={menuId}
          role="menu"
          aria-label="More sections"
          onKeyDown={onMenuKeyDown}
          className="absolute top-full right-0 z-50 mt-1 min-w-48 rounded-lg border border-border bg-surface p-1 shadow-elev-2"
        >
          {items.map((item, index) => {
            const active = isActive(item.href);
            return (
              <li key={item.href} role="none">
                <Link
                  ref={(el) => {
                    itemRefs.current[index] = el;
                  }}
                  role="menuitem"
                  tabIndex={-1}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  onClick={close}
                  className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
                    active
                      ? "bg-accent/10 text-accent"
                      : "text-foreground hover:bg-surface-2"
                  }`}
                >
                  <NavIcon name={item.icon} className="size-4 shrink-0" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

/** The little caret on the More trigger; flips when the menu is open. */
function Chevron({ open = false }: { open?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`size-3.5 shrink-0 transition-transform ${
        open ? "rotate-180" : ""
      }`}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
