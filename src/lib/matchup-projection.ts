// Relative, with the .ts the runtime wants: this helper is unit-tested
// under `node --test`, which resolves neither the `@/` tsconfig alias nor
// an extensionless specifier. The NflGame import is an erased `import type`,
// so there is no runtime dependency -- the module is pure arithmetic.
import type { NflGame } from "./types.ts";

/**
 * A starter's live NFL game status for the week, or null when his team is
 * on a bye (no game at all). Matches nfl_games.status plus that absence.
 */
export type StarterGameStatus = NflGame["status"] | null;

/** One starting player, reduced to what a projection needs. */
export interface StarterProjectionInput {
  /** Fantasy points scored so far, in the league's rules (0 before kickoff). */
  actual: number;
  /**
   * Weekly projected points, scored in the league's rules (team_projections,
   * 0028). 0 for a player with no projection -- a bye, or one not ingested.
   */
  projected: number;
  /** His NFL game's state for the week; null on a bye. */
  status: StarterGameStatus;
}

/** One side's projection, the pieces a scoreboard shows. */
export interface SideProjection {
  /**
   * Projected final score: actual points for a starter whose game is final,
   * his projection for everyone else. Reconciles to the real final once
   * every game is final (every starter then contributes actual).
   */
  projFinal: number;
  /** Starters whose game has not kicked off yet (scheduled). */
  yetToPlay: number;
  /** Projected points still to come -- the projection of every non-final starter. */
  remaining: number;
}

/** Both sides, plus the projected margin between them. */
export interface MatchupProjection {
  home: SideProjection;
  away: SideProjection;
  /** Projected margin, home minus away. Positive means home is projected to win. */
  margin: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Project one side's final score from its starters.
 *
 * A starter whose game is final is locked in at his actual points; everyone
 * else -- in progress, scheduled, postponed, or on a bye -- contributes his
 * projection, because that is still the best estimate of where he lands.
 * "Yet to play" counts only the starters who have not kicked off, and
 * "remaining" is the projection those unfinished starters still owe.
 */
export function projectSide(starters: StarterProjectionInput[]): SideProjection {
  let projFinal = 0;
  let yetToPlay = 0;
  let remaining = 0;

  for (const s of starters) {
    const isFinal = s.status === "final";
    projFinal += isFinal ? s.actual : s.projected;
    if (!isFinal) remaining += s.projected;
    if (s.status === "scheduled") yetToPlay += 1;
  }

  return {
    projFinal: round2(projFinal),
    yetToPlay,
    remaining: round2(remaining),
  };
}

/**
 * Project a whole matchup: each side's final, plus the margin between them.
 * The away side is optional so a bye week (no opponent) still returns a
 * clean zeroed half rather than forcing the caller to special-case it.
 */
export function projectMatchup(
  homeStarters: StarterProjectionInput[],
  awayStarters: StarterProjectionInput[] | null,
): MatchupProjection {
  const home = projectSide(homeStarters);
  const away = projectSide(awayStarters ?? []);
  return { home, away, margin: round2(home.projFinal - away.projFinal) };
}
