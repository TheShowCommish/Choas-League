"use client";

import { useId, useRef } from "react";
import Link from "next/link";
import { positionLabel } from "@/lib/roster-slots";
import { summarizeBreakdown } from "@/lib/score-breakdown";
import type { RosterEntry } from "@/lib/roster";

/**
 * A player in a matchup, made tappable.
 *
 * The visible row is handed in as children so each caller keeps its own
 * layout (a starter aligns to its side of the card, a bench player sits
 * in a list). This wraps it in a real <button> -- focusable, Enter/Space,
 * a proper accessible name -- that opens the week's itemised scoring.
 *
 * The breakdown is read from the score the engine already stored for this
 * player-week (entry.breakdown / entry.points), so the lines always add
 * up to the number on the row; it is never re-scored here.
 */
export function PlayerBreakdown({
  leagueId,
  entry,
  className,
  children,
}: {
  leagueId: string;
  entry: RosterEntry;
  className?: string;
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  const open = () => dialog.current?.showModal();
  const close = () => dialog.current?.close();

  const { lines } = summarizeBreakdown(entry.breakdown);
  const onBye = entry.game === null;

  // Show the points column at the fewest decimals that still (a) lets the
  // visible lines add up to the visible total and (b) never prints a real
  // contribution as "0.0". One place covers almost everything; a league
  // with two sub-0.1 rules on one player falls to two.
  const precision = reconcilePrecision(lines, entry.points);

  // The live state of the player's NFL game, said plainly: before kickoff
  // it is Scheduled, not "In progress".
  const statusLabel = onBye
    ? "BYE"
    : GAME_STATUS[entry.game?.status ?? ""] ??
      (entry.isFinal ? "Final" : "Scheduled");

  return (
    <div className={className}>
      <button
        type="button"
        onClick={open}
        aria-haspopup="dialog"
        className="w-full cursor-pointer rounded text-inherit transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {children}
      </button>

      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
        onClick={(event) => {
          // A click on the <dialog> itself, not its contents, is the backdrop.
          if (event.target === event.currentTarget) close();
        }}
        className="sheet mx-auto max-w-md text-left sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border"
      >
        <div className="sheet-body">
          <div className="flex items-start justify-between gap-3 pb-1">
            <div className="min-w-0">
              <h2 id={titleId} className="h2 truncate">
                {entry.player.full_name}
              </h2>
              <p className="muted text-xs">
                {positionLabel(entry.player.position)}
                {entry.player.team_abbr ? ` · ${entry.player.team_abbr}` : ""}
                {!onBye && entry.opponent ? ` · ${entry.opponent}` : ""}
                {` · ${statusLabel}`}
              </p>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="-mr-2 -mt-1 inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent"
            >
              <span aria-hidden className="text-xl leading-none">
                &times;
              </span>
            </button>
          </div>

          <div className="mb-3 flex items-baseline justify-between border-y border-border py-2">
            <span className="label">Week total</span>
            <span className="score text-3xl">
              {entry.points.toFixed(precision)}
            </span>
          </div>

          {lines.length === 0 ? (
            <p className="muted text-sm">
              {onBye
                ? "On a bye this week — no stats."
                : "No scoring stats recorded for this week."}
            </p>
          ) : (
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">
                Points by stat for {entry.player.full_name}
              </caption>
              <thead>
                <tr className="text-xs text-muted">
                  <th scope="col" className="py-1 text-left font-medium">
                    Stat
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    Value
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    Points
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr
                    key={line.key}
                    className="border-t border-border/60"
                  >
                    <td className="py-1.5 pr-2">{line.label}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      {line.value}
                    </td>
                    <td
                      className={`py-1.5 text-right font-medium tabular-nums ${
                        line.points < 0 ? "text-negative" : ""
                      }`}
                    >
                      {formatPoints(line.points, precision)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border font-semibold">
                  <td className="py-1.5 pr-2">Total</td>
                  <td />
                  <td className="py-1.5 text-right tabular-nums">
                    {entry.points.toFixed(precision)}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}

          <div className="mt-4 border-t border-border pt-3">
            <Link
              href={`/l/${leagueId}/players/${entry.playerId}`}
              className="text-sm text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Full player page &rarr;
            </Link>
          </div>
        </div>
      </dialog>
    </div>
  );
}

/** Points with an explicit sign, so a negative line reads as a subtraction. */
function formatPoints(points: number, precision: number): string {
  const fixed = points.toFixed(precision);
  return points > 0 ? `+${fixed}` : fixed;
}

/** What each NFL game status is called in the breakdown header. */
const GAME_STATUS: Record<string, string> = {
  scheduled: "Scheduled",
  in_progress: "In progress",
  final: "Final",
  postponed: "Postponed",
};

function roundTo(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * The fewest decimal places (1, else 2) at which the displayed lines both
 * add up to the displayed total and never show a real contribution as zero.
 * Falls back to 2 -- more faithful than 1 -- if neither is perfect.
 */
function reconcilePrecision(
  lines: { points: number }[],
  total: number,
): number {
  for (const p of [1, 2]) {
    const rounded = lines.map((l) => roundTo(l.points, p));
    const noneDropped = lines.every(
      (l, i) => l.points === 0 || rounded[i] !== 0,
    );
    const sum = roundTo(
      rounded.reduce((acc, v) => acc + v, 0),
      p,
    );
    if (noneDropped && sum === roundTo(total, p)) return p;
  }
  return 2;
}
