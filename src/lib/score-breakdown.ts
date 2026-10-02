// Relative, with the .ts the runtime wants: this helper is unit-tested
// under `node --test`, which resolves neither the `@/` tsconfig alias nor
// an extensionless specifier (the other tested libs only ever import `@/`
// as an erased `import type`). The catalog is the one runtime dependency.
import { STAT_BY_KEY } from "./stats/catalog.ts";
import type { ScoreBreakdownEntry } from "./types.ts";

/**
 * One scored stat on a player's week, ready to show: "68 Rushing Yards
 * -> 6.8". The raw value, the human label, and the points it added.
 */
export interface BreakdownLine {
  key: string;
  label: string;
  value: number;
  points: number;
}

/**
 * A player's week, itemised.
 *
 * The lines come straight from `player_week_scores.breakdown`, the jsonb
 * the scoring engine writes in the same pass it computes the total
 * (recompute_week_scores, 0012): for every stat whose rule scored, the
 * raw value and `round(value * rule.points, 2)`. Reading it back rather
 * than re-scoring here is what keeps the lines reconciled to the total --
 * there is only one scoring path, and this is its output, not a copy.
 *
 * The engine only writes a line when both the stat value and its rule
 * points are non-zero, so a zero-point stat never appears but a negative
 * one (an interception, a fumble lost) does, exactly as it affected the
 * total.
 */
export interface ScoreBreakdown {
  lines: BreakdownLine[];
  /**
   * The lines summed, rounded to two places like the engine's own total.
   * Equal to the stored `player_week_scores.points` for the same row.
   */
  total: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Turn a stored breakdown into display lines plus their total.
 *
 * Lines read biggest contribution first so the points that made the week
 * are up top; ties fall back to the stat's catalog label for a stable
 * order. An unknown key (a stat added since this row was scored) shows
 * its raw key rather than vanishing.
 */
export function summarizeBreakdown(
  breakdown: Record<string, ScoreBreakdownEntry> | null | undefined,
): ScoreBreakdown {
  const lines: BreakdownLine[] = Object.entries(breakdown ?? {}).map(
    ([key, entry]) => ({
      key,
      label: STAT_BY_KEY[key]?.label ?? key,
      value: Number(entry.value),
      points: Number(entry.points),
    }),
  );

  lines.sort((a, b) => b.points - a.points || a.label.localeCompare(b.label));

  const total = round2(lines.reduce((sum, line) => sum + line.points, 0));

  return { lines, total };
}
