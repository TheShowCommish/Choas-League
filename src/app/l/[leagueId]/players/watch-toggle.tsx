"use client";

import { useState, useTransition } from "react";
import { toggleWatch } from "@/lib/watchlist-actions";

/**
 * The star that adds or removes a player from the signed-in user's
 * watchlist (T-074). Optimistic: it flips immediately and reverts if the
 * server rejects it, so a failed toggle is a quiet no-op, never a crash.
 * Plainly styled -- the designer owns the final look.
 */
export function WatchToggle({
  leagueId,
  playerId,
  initialWatching,
  playerName,
  size = 20,
}: {
  leagueId: string;
  playerId: string;
  initialWatching: boolean;
  /** Names the player in the aria-label ("Watch <name>"); optional so the
   *  component keeps working wherever a name isn't handy. */
  playerName?: string;
  size?: number;
}) {
  const [watching, setWatching] = useState(initialWatching);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onClick() {
    setError(null);
    const next = !watching;
    setWatching(next); // optimistic
    startTransition(async () => {
      const result = await toggleWatch(leagueId, playerId);
      if (result.error) {
        setWatching(!next); // revert
        setError(result.error);
      } else if (typeof result.watching === "boolean") {
        setWatching(result.watching);
      }
    });
  }

  const label = playerName
    ? watching
      ? `Unwatch ${playerName}`
      : `Watch ${playerName}`
    : watching
      ? "Remove from watchlist"
      : "Add to watchlist";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      aria-pressed={watching}
      aria-label={label}
      title={error ?? label}
      // A full 44px tap target on phones, compact (32px) on the dense
      // desktop table. Accent when watched, a quiet muted outline when
      // not -- it has to read as "following" without shouting down the
      // player's own name beside it.
      className={`inline-flex size-11 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60 md:size-8 ${
        watching
          ? "text-accent hover:bg-accent/10"
          : "text-muted hover:bg-surface-2 hover:text-foreground"
      }`}
    >
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill={watching ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.15 1 5.85L12 17.9l-5.25 2.75 1-5.85L3.5 9.7l5.9-.9Z" />
      </svg>
    </button>
  );
}
