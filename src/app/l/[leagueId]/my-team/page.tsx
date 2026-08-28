import Link from "next/link";
import { getLeagueContext } from "@/lib/league";
import { createClient } from "@/lib/supabase/server";
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
        <p className="muted mb-3">
          You are in this league but have not taken a team. Pick one off the
          board -- you can rename it and set its colours afterwards.
        </p>
        <Link href={`/l/${leagueId}/claim`} className="btn btn-primary">
          Choose a team
        </Link>
      </div>
    );
  }

  const week = Number(weekParam) || league.current_week;
  const roster = await getTeamRoster(leagueId, myTeam.id, league.season, week);

  // Position limits count the whole roster, bench and IR included, so
  // the summary has to be about the roster rather than the lineup.
  const supabase = await createClient();
  const { data: limitRows } = await supabase
    .from("league_position_limits")
    .select("position, max_count")
    .eq("league_id", leagueId);

  const heldByPosition = new Map<string, number>();
  for (const entry of roster) {
    const position = entry.player.position;
    if (!position) continue;
    heldByPosition.set(position, (heldByPosition.get(position) ?? 0) + 1);
  }

  const limits = (limitRows ?? [])
    .map((row) => ({
      position: row.position as string,
      max: row.max_count as number,
      held: heldByPosition.get(row.position as string) ?? 0,
    }))
    .sort((a, b) => a.position.localeCompare(b.position));

  const capacity = rosterSlots.reduce((sum, slot) => sum + slot.count, 0);

  // Regular season plus the playoff rounds, so lineups can be set ahead.
  const lastWeek = Math.max(league.regular_season_weeks + 4, week);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="h1">{myTeam.name}</h1>
          <p className="muted">
            ${myTeam.faab_remaining} FAAB left &middot; waiver priority{" "}
            {myTeam.waiver_priority} &middot; {roster.length}/{capacity} players
          </p>
        </div>

        <WeekPicker
          week={week}
          lastWeek={lastWeek}
          currentWeek={league.current_week}
        />
      </header>

      {limits.length > 0 && (
        <div className="card flex flex-wrap gap-2">
          {limits.map(({ position, max, held }) => (
            <span
              key={position}
              className={`pill ${
                held > max
                  ? "border-negative text-negative"
                  : held === max
                    ? "border-positive text-positive"
                    : ""
              }`}
              title={`${held} of a maximum ${max} at ${position}`}
            >
              {position} {held}/{max}
            </span>
          ))}
        </div>
      )}

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
        currentAbbreviation={myTeam.abbreviation}
        currentColor={myTeam.color}
        currentLogoUrl={myTeam.logo_url}
      />
    </div>
  );
}
