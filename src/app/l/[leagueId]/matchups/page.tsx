import Link from "next/link";
import { getLeagueContext } from "@/lib/league";
import { createClient } from "@/lib/supabase/server";
import type { Matchup } from "@/lib/types";
import { WeekPicker } from "../week-picker";

export default async function MatchupsPage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string }>;
  searchParams: Promise<{ week?: string }>;
}) {
  const { leagueId } = await params;
  const { week: weekParam } = await searchParams;
  const { league, teams, myTeam } = await getLeagueContext(leagueId);

  const week = Number(weekParam) || league.current_week;
  const lastWeek = Math.max(league.regular_season_weeks + 4, week);

  const supabase = await createClient();
  const { data } = await supabase
    .from("matchups")
    .select("*")
    .eq("league_id", leagueId)
    .eq("season", league.season)
    .eq("week", week);

  const matchups = (data ?? []) as Matchup[];
  const teamById = new Map(teams.map((t) => [t.id, t]));

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="h1">Matchups</h1>
        <WeekPicker
          week={week}
          lastWeek={lastWeek}
          currentWeek={league.current_week}
        />
      </header>

      {matchups.length === 0 ? (
        <p className="card muted">
          No matchups scheduled for week {week}. The commissioner generates the
          schedule from the admin page.
        </p>
      ) : (
        <ul className="space-y-3">
          {matchups.map((m) => {
            const home = teamById.get(m.home_team_id);
            const away = m.away_team_id ? teamById.get(m.away_team_id) : null;
            const mine =
              m.home_team_id === myTeam?.id || m.away_team_id === myTeam?.id;

            // A matchup can outlive its team if the commissioner removes
            // one, so neither side is guaranteed to resolve.
            if (!home) return null;

            if (!away) {
              return (
                <li
                  key={m.id}
                  className={`card ${mine ? "border-accent" : ""}`}
                >
                  <p className="font-medium">{home.name}</p>
                  <p className="muted">Bye week</p>
                </li>
              );
            }

            const homeWon = Number(m.home_score) > Number(m.away_score);
            const isFinal = m.status === "final";

            return (
              <li key={m.id}>
                <Link
                  href={`/l/${leagueId}/matchups/${m.id}`}
                  className={`card block hover:border-accent ${
                    mine ? "border-accent/60" : ""
                  }`}
                >
                  <Side
                    name={away.name}
                    score={Number(m.away_score)}
                    winner={isFinal && !homeWon}
                  />
                  <Side
                    name={home.name}
                    score={Number(m.home_score)}
                    winner={isFinal && homeWon}
                  />
                  <p className="muted mt-2 text-xs">
                    {isFinal
                      ? "Final"
                      : m.status === "in_progress"
                        ? "In progress"
                        : "Scheduled"}
                    {m.is_playoff && ` · ${m.playoff_round ?? "Playoffs"}`}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Side({
  name,
  score,
  winner,
}: {
  name: string;
  score: number;
  winner: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className={`truncate ${winner ? "font-semibold" : ""}`}>
        {name}
      </span>
      <span
        className={`tabular-nums ${winner ? "font-semibold" : "text-muted"}`}
      >
        {score.toFixed(1)}
      </span>
    </div>
  );
}
