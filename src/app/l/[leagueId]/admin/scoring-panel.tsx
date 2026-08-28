"use client";

import { useActionState, useMemo, useState } from "react";
import type { ScoringRule, StatDefinition } from "@/lib/types";
import { saveScoringRules, type AdminResult } from "./actions";

const empty: AdminResult = {};

/**
 * The scoring editor: one row per scorable stat, grouped by category.
 *
 * The catalog is 170+ stats and a league will care about maybe thirty,
 * so the default view hides everything set to zero. Search and the
 * "show all" toggle are how you go find the obscure ones.
 *
 * Only changed values are submitted -- see saveScoringRules.
 */
export function ScoringPanel({
  leagueId,
  stats,
  rules,
}: {
  leagueId: string;
  stats: StatDefinition[];
  rules: ScoringRule[];
}) {
  const [state, action, pending] = useActionState(saveScoringRules, empty);

  const pointsByKey = useMemo(
    () => new Map(rules.map((r) => [r.stat_key, Number(r.points)])),
    [rules],
  );

  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      stats.map((s) => [s.key, String(pointsByKey.get(s.key) ?? 0)]),
    ),
  );

  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);

  const dirtyKeys = useMemo(
    () =>
      stats
        .filter((s) => Number(values[s.key]) !== (pointsByKey.get(s.key) ?? 0))
        .map((s) => s.key),
    [stats, values, pointsByKey],
  );

  const query = search.trim().toLowerCase();

  const visible = stats.filter((stat) => {
    if (query) {
      return (
        stat.label.toLowerCase().includes(query) ||
        stat.key.toLowerCase().includes(query) ||
        stat.category.toLowerCase().includes(query)
      );
    }
    if (showAll) return true;
    // Keep a stat visible while you are editing it, even back to zero.
    return Number(values[stat.key]) !== 0 || dirtyKeys.includes(stat.key);
  });

  const byCategory = new Map<string, StatDefinition[]>();
  for (const stat of visible) {
    const list = byCategory.get(stat.category) ?? [];
    list.push(stat);
    byCategory.set(stat.category, list);
  }

  const activeCount = stats.filter((s) => Number(values[s.key]) !== 0).length;

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="league_id" value={leagueId} />

      <div className="card space-y-3">
        <p className="muted text-sm">
          Points per unit of each stat. {activeCount} of {stats.length} stats
          are scoring. Set a stat to 0 to switch it off.
        </p>

        <input
          className="input"
          placeholder="Search stats (try: air yards, red zone, tackles)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search stats"
        />

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => setShowAll(e.target.checked)}
            className="size-4"
          />
          Show every stat, including ones worth 0
        </label>
      </div>

      {visible.length === 0 && (
        <p className="card muted">
          Nothing matches. Tick &ldquo;show every stat&rdquo; to browse the
          full catalog.
        </p>
      )}

      {[...byCategory].map(([category, categoryStats]) => (
        <section key={category} className="card-tight">
          <h3 className="border-b border-border px-3 py-2 text-sm font-semibold">
            {category}
          </h3>
          <ul className="divide-y divide-border/60">
            {categoryStats.map((stat) => {
              const changed = dirtyKeys.includes(stat.key);
              return (
                <li
                  key={stat.key}
                  className="flex items-center gap-3 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {stat.label}
                      {stat.value_type === "flag" && (
                        <span className="pill ml-2">bonus</span>
                      )}
                    </p>
                    <p className="muted text-xs">{stat.description}</p>
                  </div>

                  <input
                    type="number"
                    step="0.01"
                    className={`input w-24 text-right ${
                      changed ? "border-accent" : ""
                    }`}
                    name={changed ? `points__${stat.key}` : undefined}
                    value={values[stat.key] ?? "0"}
                    onChange={(e) =>
                      setValues((prev) => ({
                        ...prev,
                        [stat.key]: e.target.value,
                      }))
                    }
                    aria-label={`Points for ${stat.label}`}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {state.error && <p className="error-box">{state.error}</p>}
      {state.ok && <p className="ok-box">{state.ok}</p>}

      {/* Sticky so the save button is reachable without scrolling back up
          through a long list of stats. */}
      <div className="sticky bottom-20 z-10 md:bottom-4">
        <button
          className="btn btn-primary w-full shadow-lg"
          disabled={pending || dirtyKeys.length === 0}
        >
          {pending
            ? "Saving..."
            : dirtyKeys.length === 0
              ? "No changes"
              : `Save ${dirtyKeys.length} change${dirtyKeys.length === 1 ? "" : "s"}`}
        </button>
      </div>
    </form>
  );
}
