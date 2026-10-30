import Link from "next/link";
import { ordinal } from "@/lib/defense-vs-position";
import { positionLabel } from "@/lib/roster-slots";

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
 * A plain list of this week's starters and how their matchups rate. Each
 * opponent links into the points-allowed drill-down. Engineer scaffolding
 * -- plainly styled for the designer to fold into the lineup later.
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
      <div className="border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold">Matchup ratings</h2>
        <p className="muted text-xs">
          How each starter&rsquo;s opponent fares against his position this
          season. 1st = softest matchup.
        </p>
      </div>
      <ul className="divide-y divide-border/60">
        {ratings.map((r) => (
          <li
            key={r.playerId}
            className="flex items-center gap-3 px-3 py-2 text-sm"
          >
            <span className="min-w-0 flex-1 truncate font-medium">
              {r.playerName}
              <span className="muted ml-1.5 text-xs">
                {positionLabel(r.position)}
              </span>
            </span>

            {r.opponent === null ? (
              <span className="muted text-xs">BYE</span>
            ) : (
              <Link
                href={`/l/${leagueId}/defense?team=${r.opponent}&pos=${r.position}`}
                className="flex shrink-0 items-center gap-2 hover:text-accent"
              >
                <span className="text-xs">vs {r.opponent}</span>
                {r.rank !== null && r.teams !== null ? (
                  <span className="pill tabular-nums">
                    {ordinal(r.rank)} vs {positionLabel(r.position)}
                  </span>
                ) : (
                  <span className="muted text-xs">no data</span>
                )}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
