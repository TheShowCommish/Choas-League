"use client";

import { useState } from "react";
import type { ScoringRule, StatDefinition } from "@/lib/types";
import { POSITION_ORDER, positionLabel } from "@/lib/roster-slots";

// Individual defenders and individual offensive linemen are not in the
// player pool: both are rostered as team units instead (DEF and OL), the
// way ESPN has always done defenses.
//
// FLEX comes out: it is a lineup slot rather than something a player
// can be, and neither a roster limit nor a scoring override can be set
// on it.
const POSITIONS = POSITION_ORDER.filter((p) => p !== "FLEX");

interface Override {
  statKey: string;
  position: string;
  points: string;
}

/**
 * Scoring that varies by position.
 *
 * Kept apart from the main stat list rather than folded into it. A
 * league has a handful of these -- a tight end premium, a quarterback
 * who is worth fifty points for making a tackle -- and putting nine
 * boxes on each of 174 stats would mean fifteen hundred inputs to
 * express three rules.
 *
 * Every row here overrides the base rule for one position. The base
 * rule, set in the list above, still applies to everyone else.
 */
export function PositionOverrides({
  stats,
  rules,
}: {
  stats: StatDefinition[];
  rules: ScoringRule[];
}) {
  const [rows, setRows] = useState<Override[]>(() =>
    rules
      .filter((r) => r.positions.length > 0)
      .flatMap((r) =>
        r.positions.map((position) => ({
          statKey: r.stat_key,
          position,
          points: String(r.points),
        })),
      )
      .sort(
        (a, b) =>
          a.statKey.localeCompare(b.statKey) ||
          a.position.localeCompare(b.position),
      ),
  );

  const labelFor = new Map(stats.map((s) => [s.key, s.label]));

  function patch(index: number, changes: Partial<Override>) {
    setRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, ...changes } : row)),
    );
  }

  return (
    <section className="card space-y-3">
      <div>
        <h3 className="h2">Scoring by position</h3>
        <p className="muted text-sm">
          Make one stat worth a different amount at a given position. A
          quarterback&rsquo;s tackle can be worth 50 while a
          receiver&rsquo;s is worth 5. Set 0 to make the stat worth
          nothing at that position. Anything not listed here uses the
          value from the list above.
        </p>
      </div>

      {/* The whole set, as JSON, so the action can tell a removed row
          from one that was merely edited. */}
      <input
        type="hidden"
        name="position_overrides"
        value={JSON.stringify(rows)}
      />

      {rows.length === 0 ? (
        <p className="muted text-sm">
          No positional scoring yet. Everything uses its base value.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row, index) => (
            <li
              key={index}
              className="grid grid-cols-[1fr_auto_auto_auto] items-end gap-2"
            >
              <div>
                {index === 0 && (
                  <span className="label">Stat</span>
                )}
                <select
                  className="input"
                  value={row.statKey}
                  onChange={(e) => patch(index, { statKey: e.target.value })}
                  aria-label="Stat"
                >
                  <option value="">Choose a stat</option>
                  {stats.map((stat) => (
                    <option key={stat.key} value={stat.key}>
                      {stat.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                {index === 0 && <span className="label">Position</span>}
                <select
                  className="input w-24"
                  value={row.position}
                  onChange={(e) => patch(index, { position: e.target.value })}
                  aria-label="Position"
                >
                  {POSITIONS.map((position) => (
                    <option key={position} value={position}>
                      {positionLabel(position)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                {index === 0 && <span className="label">Points</span>}
                <input
                  type="number"
                  step="0.01"
                  className="input w-24 text-right"
                  value={row.points}
                  onChange={(e) => patch(index, { points: e.target.value })}
                  aria-label={`Points for ${
                    labelFor.get(row.statKey) ?? row.statKey
                  } at ${row.position}`}
                />
              </div>

              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={() =>
                  setRows((prev) => prev.filter((_, i) => i !== index))
                }
                aria-label="Remove this rule"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        className="btn w-full"
        onClick={() =>
          setRows((prev) => [
            ...prev,
            { statKey: "", position: "QB", points: "0" },
          ])
        }
      >
        Add a positional rule
      </button>
    </section>
  );
}
