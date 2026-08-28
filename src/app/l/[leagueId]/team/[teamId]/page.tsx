import Link from "next/link";
import { notFound } from "next/navigation";
import { getLeagueContext } from "@/lib/league";
import { getTeamRoster } from "@/lib/roster";
import { createClient } from "@/lib/supabase/server";
import { WeekPicker } from "../../week-picker";

export default async function TeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string; teamId: string }>;
  searchParams: Promise<{ week?: string }>;
}) {
  const { leagueId, teamId } = await params;
  const { week: weekParam } = await searchParams;
  const { league, teams, rosterSlots, myTeam } =
    await getLeagueContext(leagueId);

  const team = teams.find((t) => t.id === teamId);
  if (!team) notFound();

  const week = Number(weekParam) || league.current_week;
  const lastWeek = Math.max(league.regular_season_weeks + 4, week);

  const supabase = await createClient();
  const [roster, { data: owner }] = await Promise.all([
    getTeamRoster(leagueId, teamId, league.season, week),
    team.owner_id
      ? supabase
          .from("profiles")
          .select("display_name")
          .eq("id", team.owner_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const starterKeys = new Set(
    rosterSlots.filter((s) => s.is_starter).map((s) => s.slot_key),
  );

  const starters = roster.filter(
    (r) => r.slotKey && starterKeys.has(r.slotKey),
  );
  const bench = roster.filter((r) => !r.slotKey || !starterKeys.has(r.slotKey));
  const total = starters.reduce((sum, r) => sum + r.points, 0);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="h1">{team.name}</h1>
          <p className="muted">
            {owner?.display_name ?? "Unclaimed"} &middot; $
            {team.faab_remaining} FAAB &middot; {roster.length} players
          </p>
        </div>
        <WeekPicker
          week={week}
          lastWeek={lastWeek}
          currentWeek={league.current_week}
        />
      </header>

      {team.id === myTeam?.id && (
        <Link href={`/l/${leagueId}/my-team?week=${week}`} className="btn btn-sm">
          Edit this lineup
        </Link>
      )}

      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="h2">Starters</h2>
          <span className="tabular-nums">{total.toFixed(1)} pts</span>
        </div>
        <RosterTable leagueId={leagueId} entries={starters} showSlot />
      </section>

      <section>
        <h2 className="h2 mb-2">Bench</h2>
        <RosterTable leagueId={leagueId} entries={bench} showSlot={false} />
      </section>
    </div>
  );
}

function RosterTable({
  leagueId,
  entries,
  showSlot,
}: {
  leagueId: string;
  entries: Awaited<ReturnType<typeof getTeamRoster>>;
  showSlot: boolean;
}) {
  if (entries.length === 0) {
    return <p className="card muted">Nobody here.</p>;
  }

  return (
    <div className="card-tight table-scroll">
      <table className="table">
        <thead>
          <tr>
            {showSlot && <th className="w-14">Slot</th>}
            <th>Player</th>
            <th className="text-right">Pts</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.playerId}>
              {showSlot && (
                <td className="text-xs text-muted">{entry.slotKey}</td>
              )}
              <td>
                <Link
                  href={`/l/${leagueId}/players/${entry.playerId}`}
                  className="block font-medium hover:text-accent"
                >
                  {entry.player.full_name}
                </Link>
                <span className="muted text-xs">
                  {entry.player.position ?? "?"} &middot;{" "}
                  {entry.player.team_abbr ?? "FA"} &middot;{" "}
                  {entry.game ? entry.opponent : "BYE"}
                </span>
              </td>
              <td className="text-right tabular-nums">
                {entry.points.toFixed(1)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
