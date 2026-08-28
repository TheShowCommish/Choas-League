import Link from "next/link";
import { getLeagueContext } from "@/lib/league";
import { createClient } from "@/lib/supabase/server";
import type { Matchup, StandingsRow, Transaction } from "@/lib/types";

export default async function LeagueHomePage({
  params,
}: {
  params: Promise<{ leagueId: string }>;
}) {
  const { leagueId } = await params;
  const { league, teams, myTeam, isCommissioner } =
    await getLeagueContext(leagueId);
  const supabase = await createClient();

  const [{ data: matchups }, { data: standings }, { data: activity }] =
    await Promise.all([
      supabase
        .from("matchups")
        .select("*")
        .eq("league_id", leagueId)
        .eq("season", league.season)
        .eq("week", league.current_week),
      supabase.from("standings").select("*").eq("league_id", leagueId),
      supabase
        .from("transactions")
        .select("id, type, note, created_at, teams(name), nfl_players(full_name)")
        .eq("league_id", leagueId)
        .order("created_at", { ascending: false })
        .limit(8),
    ]);

  const teamById = new Map(teams.map((t) => [t.id, t]));
  const myMatchup = ((matchups ?? []) as Matchup[]).find(
    (m) => m.home_team_id === myTeam?.id || m.away_team_id === myTeam?.id,
  );

  const top = ((standings ?? []) as StandingsRow[])
    .sort(
      (a, b) =>
        b.wins - a.wins || Number(b.points_for) - Number(a.points_for),
    )
    .slice(0, 5);

  return (
    <div className="space-y-5">
      {league.status === "setup" && isCommissioner && (
        <div className="card border-accent">
          <h2 className="h2 mb-1">Finish setting up</h2>
          <p className="muted mb-3">
            Share the join code <strong>{league.join_code}</strong> with your
            managers, set your scoring, then generate the schedule and draft.
          </p>
          <Link href={`/l/${leagueId}/admin`} className="btn btn-primary">
            Open admin
          </Link>
        </div>
      )}

      <section>
        <h2 className="h2 mb-2">Your week {league.current_week} matchup</h2>
        {myMatchup ? (
          <MatchupCard
            leagueId={leagueId}
            matchup={myMatchup}
            homeName={teamById.get(myMatchup.home_team_id)?.name ?? "?"}
            awayName={
              myMatchup.away_team_id
                ? (teamById.get(myMatchup.away_team_id)?.name ?? "?")
                : null
            }
          />
        ) : (
          <p className="card muted">
            {myTeam
              ? "No matchup scheduled this week."
              : "You do not have a team in this league yet."}
          </p>
        )}
      </section>

      <div className="grid gap-5 md:grid-cols-2">
        <section>
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="h2">Standings</h2>
            <Link href={`/l/${leagueId}/standings`} className="muted text-sm">
              Full table
            </Link>
          </div>
          {top.length === 0 ? (
            <p className="card muted">No results yet.</p>
          ) : (
            <ol className="card-tight divide-y divide-border/60">
              {top.map((row, i) => (
                <li
                  key={row.team_id}
                  className="flex items-center gap-3 px-3 py-2 text-sm"
                >
                  <span className="muted w-4">{i + 1}</span>
                  <Link
                    href={`/l/${leagueId}/team/${row.team_id}`}
                    className="min-w-0 flex-1 truncate hover:text-accent"
                  >
                    {row.team_name}
                  </Link>
                  <span className="tabular-nums">
                    {row.wins}-{row.losses}
                    {row.ties > 0 && `-${row.ties}`}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section>
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="h2">Recent moves</h2>
            <Link href={`/l/${leagueId}/transactions`} className="muted text-sm">
              Full log
            </Link>
          </div>
          {(activity ?? []).length === 0 ? (
            <p className="card muted">Nothing yet.</p>
          ) : (
            <ul className="card-tight divide-y divide-border/60">
              {(activity ?? []).map((row) => {
                const team = row.teams as unknown as { name: string } | null;
                const player = row.nfl_players as unknown as {
                  full_name: string;
                } | null;
                return (
                  <li key={row.id as string} className="px-3 py-2 text-sm">
                    <span className="muted">{team?.name ?? "League"}</span>{" "}
                    {(row as unknown as Transaction).type.replace("_", " ")}{" "}
                    <span className="font-medium">
                      {player?.full_name ?? ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function MatchupCard({
  leagueId,
  matchup,
  homeName,
  awayName,
}: {
  leagueId: string;
  matchup: Matchup;
  homeName: string;
  awayName: string | null;
}) {
  if (!awayName) {
    return (
      <div className="card">
        <p className="font-medium">{homeName}</p>
        <p className="muted">Bye week.</p>
      </div>
    );
  }

  return (
    <Link
      href={`/l/${leagueId}/matchups/${matchup.id}`}
      className="card block hover:border-accent"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">{awayName}</p>
          <p className="text-2xl font-semibold tabular-nums">
            {Number(matchup.away_score).toFixed(1)}
          </p>
        </div>
        <span className="muted text-xs">
          {matchup.status === "final" ? "FINAL" : "vs"}
        </span>
        <div className="min-w-0 flex-1 text-right">
          <p className="truncate text-sm">{homeName}</p>
          <p className="text-2xl font-semibold tabular-nums">
            {Number(matchup.home_score).toFixed(1)}
          </p>
        </div>
      </div>
    </Link>
  );
}
