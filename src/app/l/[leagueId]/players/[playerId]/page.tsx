import Link from "next/link";
import { notFound } from "next/navigation";
import { getLeagueContext } from "@/lib/league";
import { createClient } from "@/lib/supabase/server";
import { STAT_BY_KEY } from "@/lib/stats/catalog";
import type { NflPlayer, ScoreBreakdownEntry } from "@/lib/types";

interface WeekRow {
  week: number;
  points: number;
  is_final: boolean;
  breakdown: Record<string, ScoreBreakdownEntry>;
}

interface RawStatRow {
  week: number;
  stats: Record<string, number>;
  source: string;
}

export default async function PlayerPage({
  params,
}: {
  params: Promise<{ leagueId: string; playerId: string }>;
}) {
  const { leagueId, playerId } = await params;
  const { league } = await getLeagueContext(leagueId);
  const supabase = await createClient();

  const [{ data: player }, { data: scores }, { data: raw }, { data: owner }] =
    await Promise.all([
      supabase.from("nfl_players").select("*").eq("id", playerId).maybeSingle(),
      supabase
        .from("player_week_scores")
        .select("week, points, is_final, breakdown")
        .eq("league_id", leagueId)
        .eq("player_id", playerId)
        .eq("season", league.season)
        .order("week"),
      supabase
        .from("player_game_stats")
        .select("week, stats, source")
        .eq("player_id", playerId)
        .eq("season", league.season)
        .order("week"),
      supabase
        .from("roster_players")
        .select("team_id, teams(name)")
        .eq("league_id", leagueId)
        .eq("player_id", playerId)
        .is("dropped_at", null)
        .maybeSingle(),
    ]);

  if (!player) notFound();

  const p = player as NflPlayer;
  const weeks = (scores ?? []) as WeekRow[];
  const rawByWeek = new Map(
    ((raw ?? []) as RawStatRow[]).map((r) => [r.week, r.stats]),
  );

  const total = weeks.reduce((sum, w) => sum + Number(w.points), 0);
  const ownerName = (owner?.teams as unknown as { name: string } | null)?.name;

  // Every stat this player has recorded all season, most productive first.
  const seasonTotals = new Map<string, number>();
  for (const stats of rawByWeek.values()) {
    for (const [key, value] of Object.entries(stats)) {
      if (typeof value !== "number") continue;
      seasonTotals.set(key, (seasonTotals.get(key) ?? 0) + value);
    }
  }

  return (
    <div className="space-y-5">
      <header>
        <Link href={`/l/${leagueId}/players`} className="muted text-sm">
          &larr; All players
        </Link>
        <h1 className="h1 mt-1">{p.full_name}</h1>
        <p className="muted">
          {p.position ?? "?"} &middot; {p.team_abbr ?? "Free agent"}
          {p.jersey_number != null && <> &middot; #{p.jersey_number}</>}
          {ownerName ? (
            <> &middot; rostered by {ownerName}</>
          ) : (
            <> &middot; available</>
          )}
        </p>
      </header>

      <div className="card flex flex-wrap gap-4">
        <Stat label="Season points" value={total.toFixed(1)} />
        <Stat label="Games" value={String(weeks.length)} />
        <Stat
          label="Average"
          value={weeks.length ? (total / weeks.length).toFixed(1) : "0.0"}
        />
        <Stat
          label="Best week"
          value={
            weeks.length
              ? Math.max(...weeks.map((w) => Number(w.points))).toFixed(1)
              : "0.0"
          }
        />
      </div>

      <section>
        <h2 className="h2 mb-2">Week by week</h2>
        {weeks.length === 0 ? (
          <p className="card muted">No scored games yet this season.</p>
        ) : (
          <div className="space-y-2">
            {weeks.map((w) => (
              <WeekCard
                key={w.week}
                week={w}
                rawStats={rawByWeek.get(w.week) ?? {}}
              />
            ))}
          </div>
        )}
      </section>

      {seasonTotals.size > 0 && (
        <section>
          <h2 className="h2 mb-2">Season stat totals</h2>
          <p className="muted mb-2 text-sm">
            Everything recorded for this player, whether or not your league
            scores it.
          </p>
          <div className="card-tight table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Stat</th>
                  <th className="text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {[...seasonTotals.entries()]
                  .filter(([, value]) => value !== 0)
                  .sort((a, b) => a[0].localeCompare(b[0]))
                  .map(([key, value]) => (
                    <tr key={key}>
                      <td>
                        {STAT_BY_KEY[key]?.label ?? key}
                        <span className="muted ml-2 text-xs">
                          {STAT_BY_KEY[key]?.category}
                        </span>
                      </td>
                      <td className="text-right tabular-nums">
                        {round(value)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="muted text-xs">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

/**
 * One week, expandable to show exactly which stats produced the score.
 * Being able to audit the maths matters when the league scores 40 stats.
 */
function WeekCard({
  week,
  rawStats,
}: {
  week: WeekRow;
  rawStats: Record<string, number>;
}) {
  const scoring = Object.entries(week.breakdown).sort(
    (a, b) => Math.abs(b[1].points) - Math.abs(a[1].points),
  );

  const unscored = Object.entries(rawStats).filter(
    ([key, value]) => value !== 0 && !(key in week.breakdown),
  );

  return (
    <details className="card-tight">
      <summary className="flex cursor-pointer items-center justify-between gap-3 p-3">
        <span className="text-sm font-medium">Week {week.week}</span>
        <span className="tabular-nums">
          {Number(week.points).toFixed(1)}
          {!week.is_final && <span className="muted text-xs"> (live)</span>}
        </span>
      </summary>

      <div className="border-t border-border px-3 py-2">
        {scoring.length === 0 ? (
          <p className="muted text-sm">Nothing scored this week.</p>
        ) : (
          <table className="table">
            <tbody>
              {scoring.map(([key, entry]) => (
                <tr key={key}>
                  <td>{STAT_BY_KEY[key]?.label ?? key}</td>
                  <td className="text-right tabular-nums">
                    {round(entry.value)}
                  </td>
                  <td
                    className={`text-right tabular-nums ${
                      entry.points < 0 ? "text-negative" : "text-positive"
                    }`}
                  >
                    {entry.points > 0 ? "+" : ""}
                    {Number(entry.points).toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {unscored.length > 0 && (
          <details className="mt-2">
            <summary className="muted cursor-pointer text-xs">
              {unscored.length} other stats recorded (worth 0 in this league)
            </summary>
            <p className="muted mt-1 text-xs">
              {unscored
                .map(
                  ([key, value]) =>
                    `${STAT_BY_KEY[key]?.label ?? key}: ${round(value)}`,
                )
                .join(" · ")}
            </p>
          </details>
        )}
      </div>
    </details>
  );
}

/** Stat values are a mix of integers and decimals; show only what is there. */
function round(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
