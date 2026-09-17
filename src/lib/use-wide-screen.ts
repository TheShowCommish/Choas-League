"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the screen is wide enough for the desktop view of a page.
 *
 * The same 48rem (Tailwind's md) the phone bottom nav switches at, so a
 * page never shows its desktop layout under the phone nav or the other
 * way round. For client components that hold state both views share and
 * so can't simply render both and hide one with CSS -- two copies of a
 * form would mean two sets of element ids.
 *
 * The server snapshot says "wide": desktop is where a decision-making
 * screen is expected, and a phone corrects it on the first client render.
 */
const QUERY = "(min-width: 48rem)";

function subscribe(listener: () => void) {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

export function useWideScreen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => true,
  );
}
