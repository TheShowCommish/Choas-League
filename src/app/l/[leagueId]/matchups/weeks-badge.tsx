import {
  matchupCoversWeek,
  matchupSpanLabel,
  matchupWeekOfLabel,
} from "@/lib/matchup-weeks";
import type { Matchup } from "@/lib/types";

/**
 * The badge a multi-week matchup wears wherever it is shown.
 *
 * Given the week being looked at, it says where in the span that week
 * falls and what the span is ("Week 1 of 2 · Weeks 15–16"); `compact`
 * keeps only the first half, for places that are already short of room
 * or already say the span. Without a week it is just the span. A
 * single-week matchup gets nothing: "Week 15" is said elsewhere.
 */
export function WeeksBadge({
  matchup,
  week,
  compact = false,
  className = "",
}: {
  matchup: Pick<Matchup, "week" | "week_count">;
  week?: number;
  compact?: boolean;
  className?: string;
}) {
  if ((matchup.week_count ?? 1) <= 1) return null;

  const span = matchupSpanLabel(matchup);
  const weekOf =
    week !== undefined && matchupCoversWeek(matchup, week)
      ? matchupWeekOfLabel(matchup, week)
      : null;

  return (
    <span
      className={`badge-weeks ${className}`}
      title={weekOf ? `${weekOf}, ${span}` : span}
    >
      {weekOf ?? span}
      {weekOf && !compact && (
        <>
          <span aria-hidden className="opacity-50">
            &middot;
          </span>
          <span className="font-normal">{span}</span>
        </>
      )}
    </span>
  );
}
