"use client";

import { usePathname } from "next/navigation";

/**
 * How wide the page is allowed to be.
 *
 * Most screens here are a reading column and stay at max-w-5xl: a
 * standings table stretched across a 34-inch monitor is harder to read,
 * not easier. The draft room is the exception. It is three panels
 * working at once -- the board, the pool, your queue and roster -- and
 * every one of them is starved at 64rem while the desk it is running on
 * has twice that.
 *
 * A client component because the layout is shared and only the route
 * knows which kind of page this is; the alternative was threading a
 * flag through every page in the section.
 */
const WIDE_SEGMENTS = ["/draft"];

export function LeagueMain({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const wide = WIDE_SEGMENTS.some((segment) => pathname.includes(segment));

  return (
    // pb-bottom-nav leaves room for the fixed bottom nav, and the home
    // indicator under it, on phones.
    <main
      className={`mx-auto w-full flex-1 px-4 py-5 pb-bottom-nav md:pb-8 ${
        wide ? "max-w-none 2xl:px-8" : "max-w-5xl"
      }`}
    >
      {children}
    </main>
  );
}
