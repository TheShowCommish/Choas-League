import Link from "next/link";
import { safeColor, tint } from "@/lib/colors";
import { matchupSpanLabel, matchupWinner } from "@/lib/matchup-weeks";
import type { Matchup, Team } from "@/lib/types";
import { TeamCrest } from "../team-theme";
import { WeeksBadge } from "./weeks-badge";

/**
 * One side of a game, wearing its own colours.
 *
 * The wash and the edge are the point: a column of eleven fixtures in
 * the same grey is a column you have to read, and a manager scanning
 * for their own game should be able to find it by colour before they
 * have read a single name. It fades to transparent rather than sitting
 * on a fixed background so it works on the light theme, the dark one
 * and a team-coloured one without three sets of values.
 */
export function MatchupSide({
  team,
  score,
  winner,
  seed = null,
  showScore = true,
  size = 28,
  advances = false,
}: {
  team: Team | null;
  score: number;
  /** Bolded, and given a brighter wash. Only ever true once a game is final. */
  winner: boolean;
  /** Playoff seeding, shown ahead of the name. Null outside the playoffs. */
  seed?: number | null;
  showScore?: boolean;
  size?: number;
  /**
   * Goes through despite not being the winner: the loser of a final
   * toilet bowl game. Said in words, because bold on the other side
   * would otherwise suggest the opposite.
   */
  advances?: boolean;
}) {
  if (!team) {
    return (
      <div className="flex items-center gap-2 rounded-md border-l-4 border-border px-2 py-1.5">
        <span className="muted text-sm">Bye</span>
      </div>
    );
  }

  const color = safeColor(team.color);

  return (
    <div
      className="flex items-center gap-2 rounded-md py-1.5 pr-2 pl-2"
      style={{
        borderLeft: `4px solid ${color}`,
        background: `linear-gradient(90deg, ${tint(color, winner ? 30 : 16)}, transparent 70%)`,
      }}
    >
      <TeamCrest
        logoUrl={team.logo_url}
        abbreviation={team.abbreviation}
        name={team.name}
        color={team.color}
        secondary={team.secondary_color}
        size={size}
      />
      {seed != null && (
        <span
          className="muted shrink-0 text-xs tabular-nums"
          title={`Seed ${seed}`}
        >
          {seed}
        </span>
      )}
      <span
        className={`min-w-0 flex-1 truncate text-sm ${winner ? "font-semibold" : ""}`}
      >
        {team.name}
      </span>
      {advances && (
        <span className="badge-negative px-1.5">
          <span aria-hidden>&darr;</span> Advances
        </span>
      )}
      {showScore && (
        <span
          className={`shrink-0 tabular-nums ${winner ? "font-semibold" : "text-muted"}`}
        >
          {score.toFixed(1)}
        </span>
      )}
    </div>
  );
}

/** How a game is doing, in the two words it takes to say. */
export function matchupStatusLabel(matchup: Matchup): string {
  if (matchup.status === "final") return "Final";
  return matchup.status === "in_progress" ? "In progress" : "Scheduled";
}

/**
 * A fixture as it appears in a list or a bracket: both sides, the
 * score, and what week it is being played.
 */
export function MatchupCard({
  leagueId,
  matchup,
  home,
  away,
  mine,
  compact = false,
  seeds,
  week,
  losersAdvance = false,
}: {
  leagueId: string;
  matchup: Matchup;
  home: Team | null;
  away: Team | null;
  /** One of the two teams is the viewer's, so the card is outlined. */
  mine: boolean;
  compact?: boolean;
  /** team id -> playoff seed. Absent outside the bracket. */
  seeds?: Map<string, number>;
  /** The week being browsed, so a multi-week card can say "Week 2 of 2". */
  week?: number;
  /** A toilet bowl game, where the losing side is the one that goes on. */
  losersAdvance?: boolean;
}) {
  const isFinal = matchup.status === "final";
  // Neither side wins a tie.
  const winnerSide = matchupWinner(matchup);
  const homeWon = winnerSide === "home";
  const awayWon = winnerSide === "away";

  // A round can span two weeks, in which case the score is both added
  // together and the label has to say so.
  const weekLabel = matchupSpanLabel(matchup);
  const multiWeek = (matchup.week_count ?? 1) > 1;

  return (
    <Link
      href={`/l/${leagueId}/matchups/${matchup.id}`}
      className={`card-tight block space-y-1 p-2 transition-colors hover:border-accent ${
        mine ? "border-accent/60" : ""
      }`}
    >
      <MatchupSide
        team={away}
        score={Number(matchup.away_score)}
        winner={isFinal && awayWon && away !== null}
        seed={away ? (seeds?.get(away.id) ?? null) : null}
        size={compact ? 22 : 28}
        advances={losersAdvance && homeWon && away !== null}
      />
      <MatchupSide
        team={home}
        score={Number(matchup.home_score)}
        winner={isFinal && homeWon}
        seed={home ? (seeds?.get(home.id) ?? null) : null}
        size={compact ? 22 : 28}
        advances={losersAdvance && awayWon}
      />
      <div className="flex items-center gap-2 px-1">
        <p className="muted min-w-0 flex-1 truncate text-xs">
          {matchupStatusLabel(matchup)}
          {matchup.is_playoff &&
            ` \u00b7 ${matchup.playoff_round ?? "Playoffs"}`}
          {compact && !multiWeek && ` \u00b7 ${weekLabel}`}
        </p>
        {/* A multi-week game says so in a badge, which a scan down a
            column of cards picks out; compact keeps it to one phrase. */}
        <WeeksBadge matchup={matchup} week={week} compact={compact} />
      </div>
    </Link>
  );
}
