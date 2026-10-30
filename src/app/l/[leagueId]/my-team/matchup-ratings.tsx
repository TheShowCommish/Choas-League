import Link from "next/link";
import { ordinal } from "@/lib/defense-vs-position";
import { positionLabel } from "@/lib/roster-slots";
import {
  DIFFICULTY_CHIP,
  DIFFICULTY_WORD,
  difficultyTier,
} from "../defense/difficulty";

/**
 * One starter's opponent-matchup rating (T-089): how the defense he faces
 * this week fares against his position, season to date in this league's
 * scoring. rank null means a bye, or nobody at the position has scored
 * against that defence yet.
 */
export interface StarterRating {
  playerId: string;
  playerName: string;
  /** Position code (QB, RB, ...). */
  position: string;
  /** The NFL defense he faces, abbr; null on a bye. */
  opponent: string | null;
  rank: number | null;
  teams: number | null;
}

/**
 * This week's starters and how their matchups rate, read like ESPN's
 * matchup column: position, opponent, and a colour-coded difficulty pill.
 * Green = a soft matchup (the defence allows a lot to the position), red =
 * a tough one; the opponent links into the points-allowed drill-down. A
 * compact card that sits above the lineup editor.
 */
export function MatchupRatings({
  leagueId,
  ratings,
}: {
  leagueId: string;
  ratings: StarterRating[];
}) {
  if (ratings.length === 0) return null;

  return (
    <section className="card-tight overflow-hidden">
      <div className="border-b border-border px-3 py-2.5">
        <h2 className="h2 text-base">Matchup ratings</h2>
        <p className="muted text-xs">
          How each starter&rsquo;s opponent fares against his position this
          season.{" "}
          <span className="text-positive">Green</span> is a soft matchup,{" "}
          <span className="text-negative">red</span> is tough.
        </p>
      </div>
      <ul className="divide-y divide-border/60">
        {ratings.map((r) => {
          const posLabel = positionLabel(r.position);
          return (
            <li
              key={r.playerId}
              className="flex items-center gap-2.5 px-3 py-2.5 text-sm"
            >
              <span className="inline-flex min-w-10 shrink-0 justify-center rounded border border-border bg-surface-2 px-1 py-0.5 text-[11px] font-semibold tracking-wide text-muted uppercase">
                {posLabel}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">
                {r.playerName}
              </span>

              {r.opponent === null ? (
                <span className="inline-flex shrink-0 items-center rounded-full border border-dashed border-border px-2 py-0.5 text-xs font-medium text-muted">
                  BYE
                </span>
              ) : (
                <Link
                  href={`/l/${leagueId}/defense?team=${r.opponent}&pos=${r.position}`}
                  className="group flex shrink-0 items-center gap-2"
                >
                  <span className="text-xs text-muted group-hover:text-accent">
                    vs {r.opponent}
                  </span>
                  {r.rank !== null && r.teams !== null ? (
                    (() => {
                      const tier = difficultyTier(r.rank, r.teams);
                      return (
                        <span
                          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold tabular-nums ${DIFFICULTY_CHIP[tier]}`}
                          aria-label={`${r.opponent} allows the ${ordinal(
                            r.rank,
                          )}-most to ${posLabel} of ${r.teams} defenses — ${
                            DIFFICULTY_WORD[tier]
                          } matchup`}
                          title={`${DIFFICULTY_WORD[tier]} matchup — ${ordinal(
                            r.rank,
                          )} of ${r.teams} vs ${posLabel}`}
                        >
                          <span aria-hidden>{DIFFICULTY_WORD[tier]}</span>
                          <span aria-hidden className="opacity-70">
                            {ordinal(r.rank)}
                          </span>
                        </span>
                      );
                    })()
                  ) : (
                    <span className="pill">no data</span>
                  )}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
