import Link from "next/link";
import { getLeagueContext } from "@/lib/league";
import { getTeamRoster } from "@/lib/roster";
import { LineupEditor } from "./editor";
import { TeamNameForm } from "./team-name-form";
import { WeekPicker } from "../week-picker";

export default async function MyTeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string }>;
  searchParams: Promise<{ week?: string }>;
}) {
  const { leagueId } = await params;
  const { week: weekParam } = await searchParams;
  const { league, myTeam, rosterSlots } = await getLeagueContext(leagueId);

  if (!myTeam) {
    return (
      <div className="card">
        <h1 className="h1 mb-2">No team yet</h1>
        <p className="muted">
          You are in this league but do not own a team. Ask the commissioner
          to assign you one.
        </p>
      </div>
    );
  }

  const week = Number(weekParam) || league.current_week;
  const roster = await getTeamRoster(leagueId, myTeam.id, league.season, week);

  // Regular season plus the playoff rounds, so lineups can be set ahead.
  const lastWeek = Math.max(league.regular_season_weeks + 4, week);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="h1">{myTeam.name}</h1>
          <p className="muted">
            ${myTeam.faab_remaining} FAAB left &middot; waiver priority{" "}
            {myTeam.waiver_priority} &middot; {roster.length} players
          </p>
        </div>

        <WeekPicker
          week={week}
          lastWeek={lastWeek}
          currentWeek={league.current_week}
        />
      </header>

      {roster.length === 0 ? (
        <div className="card">
          <p className="muted mb-3">
            Your roster is empty. Add players from the free agent pool, or wait
            for the draft.
          </p>
          <Link href={`/l/${leagueId}/players`} className="btn btn-primary">
            Find players
          </Link>
        </div>
      ) : (
        <LineupEditor
          leagueId={leagueId}
          teamId={myTeam.id}
          season={league.season}
          week={week}
          slots={rosterSlots}
          roster={roster}
        />
      )}

      <TeamNameForm
        leagueId={leagueId}
        teamId={myTeam.id}
        currentName={myTeam.name}
      />
    </div>
  );
}
