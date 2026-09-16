"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import { ThemeSwitch } from "@/app/theme-switch";
import { NavIcon, type NavIconName } from "./nav-icons";

export interface MobileNavItem {
  href: string;
  label: string;
  icon: NavIconName;
}

/**
 * The phone nav: four tabs and a More sheet.
 *
 * Ten tabs in a 375px bar meant half of them lived offscreen with no
 * hint they were there. Five is what fits a thumb and a label without
 * scrolling at 320px, so the four places a manager goes every day get a
 * tab each and everything else -- plus the theme and Sign out, which
 * used to cost the phone header a whole row -- lives one tap further in
 * the sheet. Nothing is more than two taps away.
 *
 * The sheet is a native <dialog> opened with showModal(): the browser
 * supplies the focus trap, makes the page behind it inert, closes it on
 * Escape and hands focus back to the More button afterwards, which is
 * everything a hand-rolled overlay tends to get subtly wrong.
 */
export function MobileNav({
  primary,
  secondary,
  isActive,
}: {
  primary: MobileNavItem[];
  secondary: MobileNavItem[];
  isActive: (href: string) => boolean;
}) {
  const pathname = usePathname();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  // The sheet is open *for a page*. Navigating anywhere -- a link in the
  // sheet, the back button -- changes the pathname and closes it with no
  // effect needed to notice.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  // Lock the page behind the sheet. showModal makes it inert, not
  // unscrollable, and a page sliding about under a sheet feels broken.
  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = previous;
    };
  }, [open]);

  // Rotating a tablet past the breakpoint hides the bar; a modal sheet
  // left open behind it would keep the whole page inert.
  useEffect(() => {
    if (!open) return;
    const wide = window.matchMedia("(min-width: 48rem)");
    function onChange() {
      if (wide.matches) setOpenOn(null);
    }
    wide.addEventListener("change", onChange);
    return () => wide.removeEventListener("change", onChange);
  }, [open]);

  const close = () => setOpenOn(null);
  const hiddenCurrent = secondary.find((item) => isActive(item.href));

  const tabClass = (active: boolean) =>
    `relative flex h-full w-full flex-col items-center justify-center gap-0.5 text-[11px] leading-tight font-medium transition-colors focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-accent ${
      active ? "text-accent" : "text-muted hover:text-foreground"
    }`;

  // The little bar above the active tab. Colour carries the state too,
  // but a shape change keeps it readable for anyone who can't tell the
  // accent from the muted grey.
  const indicator = (
    <span
      aria-hidden
      className="absolute top-0 left-1/2 h-0.5 w-8 -translate-x-1/2 rounded-full bg-accent"
    />
  );

  return (
    <>
      <nav
        aria-label="League"
        className="bottom-nav fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface md:hidden"
      >
        <ul className="grid h-(--bottom-nav-h) grid-cols-5">
          {primary.map((item) => {
            const active = isActive(item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={tabClass(active)}
                >
                  {active && indicator}
                  <NavIcon name={item.icon} />
                  <span className="max-w-full truncate px-0.5">
                    {item.label}
                  </span>
                </Link>
              </li>
            );
          })}

          <li>
            <button
              type="button"
              onClick={() => setOpenOn(pathname)}
              aria-haspopup="dialog"
              aria-expanded={open}
              className={tabClass(hiddenCurrent !== undefined)}
            >
              {hiddenCurrent && indicator}
              <span className="relative">
                <NavIcon name="more" />
                {hiddenCurrent && (
                  <span
                    aria-hidden
                    className="absolute -top-0.5 -right-1 size-2.5 rounded-full bg-accent ring-2 ring-surface"
                  />
                )}
              </span>
              <span>More</span>
              {hiddenCurrent && (
                <span className="sr-only">
                  , current page: {hiddenCurrent.label}
                </span>
              )}
            </button>
          </li>
        </ul>
      </nav>

      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        onClose={close}
        onKeyDown={(event) => {
          // Browsers close a modal dialog on Escape themselves, but not
          // every one routes every Escape there (some webviews, synthetic
          // keys), and a sheet that will not close is a trap.
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
        onClick={(event) => {
          // A click that lands on the <dialog> itself, not its contents,
          // is a click on the backdrop.
          if (event.target === event.currentTarget) close();
        }}
        className="sheet md:hidden"
      >
        <div className="sheet-body">
          <div className="flex items-center justify-between gap-3 pb-2">
            <h2 id={titleId} className="h2">
              More
            </h2>
            <button
              type="button"
              onClick={close}
              aria-label="Close menu"
              className="-mr-2 inline-flex size-11 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent"
            >
              <NavIcon name="close" className="size-5" />
            </button>
          </div>

          <ul className="grid grid-cols-3 gap-2">
            {secondary.map((item) => {
              const active = isActive(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={close}
                    aria-current={active ? "page" : undefined}
                    className={`flex min-h-18 flex-col items-center justify-center gap-1.5 rounded-lg border px-1 py-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                      active
                        ? "border-accent/50 bg-accent/10 text-accent"
                        : "border-border bg-surface-2 text-foreground hover:bg-border"
                    }`}
                  >
                    <NavIcon name={item.icon} />
                    <span className="max-w-full truncate">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>

          <div className="mt-4 space-y-3 border-t border-border pt-4">
            <div>
              <p className="label">Theme</p>
              <ThemeSwitch size="lg" />
            </div>
            <form action="/auth/signout" method="post">
              <button className="btn w-full">Sign out</button>
            </form>
          </div>
        </div>
      </dialog>
    </>
  );
}
