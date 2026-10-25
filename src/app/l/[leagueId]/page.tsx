import Link from "next/link";
import { getLeagueContext } from "@/lib/league";
import { fetchMatchupsCoveringWeek, matchupWinner } from "@/lib/matchup-weeks";
import { getTeamRoster } from "@/lib/roster";
import { lineupHealth, startersFromRoster } from "@/lib/roster-health";
import { makesPlayoffs } from "@/lib/standings-order";
import { createClient } from "@/lib/supabase/server";
import type { Matchup, StandingsRow, Transaction } from "@/lib/types";
import { LineupHealthBanner } from "./lineup-health";
import { matchupStatusLabel } from "./matchups/matchup-card";
import { WeeksBadge } from "./matchups/weeks-badge";

export default async function LeagueHomePage({
  params,
}: {
  params: Promise<{ leagueId: string }>;
}) {
  const { leagueId } = await params;
  const { league, teams, myTeam, rosterSlots, isCommissioner } =
    await getLeagueContext(leagueId);
  const supabase = await createClient();

  const [matchups, { data: standings }, { data: activity }, ownRoster] =
    await Promise.all([
      fetchMatchupsCoveringWeek(supabase, {
        leagueId,
        season: league.season,
        week: league.current_week,
      }),
      supabase.from("standings").select("*").eq("league_id", leagueId),
      supabase
        .from("transactions")
        .select(
          "id, type, note, created_at, teams!transactions_team_id_fkey(name), nfl_players(full_name)",
        )
        .eq("league_id", leagueId)
        .order("created_at", { ascending: false })
        .limit(8),
      myTeam
        ? getTeamRoster(
            leagueId,
            myTeam.id,
            league.season,
            league.current_week,
          )
        : Promise.resolve(null),
    ]);

  const teamById = new Map(teams.map((t) => [t.id, t]));
  const myMatchup = matchups.find(
    (m) => m.home_team_id === myTeam?.id || m.away_team_id === myTeam?.id,
  );

  // Roster-health nudge (T-075): the viewer's own current-week starters,
  // only for a team that has players and while the week can still be
  // changed (not everyone locked at kickoff). My Team shows the full
  // list; here it is a one-line link.
  let health = null;
  if (ownRoster && ownRoster.length > 0) {
    const allLocked = ownRoster.every((entry) => entry.locked);
    if (!allLocked) {
      health = lineupHealth(startersFromRoster(ownRoster, rosterSlots));
    }
  }

  const top = ((standings ?? []) as StandingsRow[])
    .sort(
      (a, b) =>
        b.wins - a.wins || Number(b.points_for) - Number(a.points_for),
    )
    .slice(0, 5);

  return (
    <div className="space-y-5">
      {health && (
        <LineupHealthBanner health={health} leagueId={leagueId} compact />
      )}

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
        <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
          <h2 className="h2">Your week {league.current_week} matchup</h2>
          {myMatchup && (
            <WeeksBadge matchup={myMatchup} week={league.current_week} />
          )}
        </div>
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
              ? "No matchup on the board this week."
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
            <p className="card muted">No standings yet — nobody has played a down.</p>
          ) : (
            <ol className="card-tight divide-y divide-border/60">
              {top.map((row, i) => {
                const inPlayoffs = makesPlayoffs(i, league.playoff_teams);
                return (
                  <li
                    key={row.team_id}
                    className="flex items-center gap-3 px-3 py-2 text-sm"
                  >
                    <span className="flex w-5 shrink-0 items-center gap-1">
                      <span
                        aria-hidden="true"
                        className={`size-1.5 rounded-full ${
                          inPlayoffs ? "bg-positive" : "bg-transparent"
                        }`}
                      />
                      <span
                        className={`tabular-nums ${
                          inPlayoffs ? "score text-positive" : "text-muted"
                        }`}
                      >
                        {i + 1}
                      </span>
                    </span>
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
                );
              })}
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
            <p className="card muted">Quiet so far. Adds, drops and trades land here.</p>
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

  // On a final, dim the losing side's score; a tie (winner null) dims
  // neither. matchupStatusLabel gives the same Scheduled/In progress/Final
  // wording the matchup list and My Team preview use.
  const winner = matchupWinner(matchup);
  const awayLost = winner === "home";
  const homeLost = winner === "away";

  return (
    <Link
      href={`/l/${leagueId}/matchups/${matchup.id}`}
      className="card block hover:border-accent"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">{awayName}</p>
          <p
            className={`score text-3xl md:text-4xl ${awayLost ? "text-muted" : ""}`}
          >
            {Number(matchup.away_score).toFixed(1)}
          </p>
        </div>
        <span className="muted shrink-0 text-xs font-semibold tracking-wide uppercase">
          {matchupStatusLabel(matchup)}
        </span>
        <div className="min-w-0 flex-1 text-right">
          <p className="truncate text-sm">{homeName}</p>
          <p
            className={`score text-3xl md:text-4xl ${homeLost ? "text-muted" : ""}`}
          >
            {Number(matchup.home_score).toFixed(1)}
          </p>
        </div>
      </div>
    </Link>
  );
}
