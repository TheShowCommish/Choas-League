/**
 * Player compare (T-080): the pure logic behind the side-by-side view
 * (ESPN/Yahoo/Sleeper parity). The page loads 2-3 players' comparable
 * numbers; this turns them into the rows the table renders and marks the
 * best player in each row, so the page and the unit test agree on both.
 *
 * Everything here is deterministic and free of data access, so the page
 * and the test build the same rows from the same inputs.
 */

/** A player's comparable numbers, as loaded for the compare view. */
export interface ComparePlayerStats {
  /** Season average fantasy points, this league's scoring. */
  avg: number;
  /** Season total fantasy points. */
  total: number;
  /** Last completed week's fantasy points. */
  last: number;
  /**
   * Next week's projected fantasy points, scored with this league's rules.
   * null when there is no projection to show (e.g. a non-league season, or
   * the feed has nothing for him this week).
   */
  projection: number | null;
}

/** A player chosen for comparison, with his comparable numbers. */
export interface ComparePlayer {
  id: string;
  name: string;
  position: string | null;
  teamAbbr: string | null;
  headshotUrl: string | null;
  /** Next week's opponent abbreviation, or null for a bye / unknown. */
  nextOpponent: string | null;
  stats: ComparePlayerStats;
}

/** Which comparable number a row reports. */
export type CompareMetricKey = keyof ComparePlayerStats;

/** The metrics shown, in display order. Higher is better for all of them. */
export const COMPARE_METRICS: { key: CompareMetricKey; label: string }[] = [
  { key: "avg", label: "Season avg" },
  { key: "total", label: "Season total" },
  { key: "last", label: "Last week" },
  { key: "projection", label: "Next week projected" },
];

/** One row of the compare table: a metric and each player's value in it. */
export interface CompareRow {
  key: CompareMetricKey;
  label: string;
  /** One value per player, in the order the players were given. */
  values: (number | null)[];
  /**
   * The index of the single best (highest) player in this row, or null when
   * there is nothing to highlight: fewer than two players, no values, or a
   * tie for the top. Highlighting a shared top would mislead.
   */
  bestIndex: number | null;
}

/**
 * The index of the single highest value, or null when there is no clear
 * winner: an empty list, every value null, or a tie for the maximum.
 */
function bestOf(values: (number | null)[]): number | null {
  let bestIndex: number | null = null;
  let bestValue = -Infinity;
  let tied = false;

  values.forEach((value, index) => {
    if (value === null) return;
    if (value > bestValue) {
      bestValue = value;
      bestIndex = index;
      tied = false;
    } else if (value === bestValue) {
      tied = true;
    }
  });

  return tied ? null : bestIndex;
}

/**
 * Build the compare rows for the chosen players, one row per metric, each
 * row carrying every player's value and which player leads it. A highlight
 * only appears when two or more players are being compared and one of them
 * clearly leads the row.
 */
export function buildCompareRows(players: ComparePlayer[]): CompareRow[] {
  return COMPARE_METRICS.map(({ key, label }) => {
    const values = players.map((p) => p.stats[key]);
    return {
      key,
      label,
      values,
      bestIndex: players.length < 2 ? null : bestOf(values),
    };
  });
}

/** Cap on how many players can be compared at once. */
export const MAX_COMPARE = 3;

/**
 * Normalise a raw `players` query param ("id1,id2,id3") into a clean,
 * de-duplicated list of ids, capped at {@link MAX_COMPARE}. Blank entries
 * are dropped; order is preserved.
 */
export function parsePlayerParam(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_COMPARE) break;
  }
  return ids;
}
