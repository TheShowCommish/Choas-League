import Link from "next/link";
import { getLeagueContext } from "@/lib/league";
import { createClient } from "@/lib/supabase/server";
import type { Profile, StandingsRow } from "@/lib/types";

export default async function StandingsPage({
  params,
}: {
  params: Promise<{ leagueId: string }>;
}) {
  const { leagueId } = await params;
  const { league, myTeam } = await getLeagueContext(leagueId);
  const supabase = await createClient();

  const [{ data: rows }, { data: profiles }] = await Promise.all([
    supabase.from("standings").select("*").eq("league_id", leagueId),
    supabase.from("profiles").select("id, display_name"),
  ]);

  const ownerName = new Map(
    ((profiles ?? []) as Pick<Profile, "id" | "display_name">[]).map((p) => [
      p.id,
      p.display_name,
    ]),
  );

  // Standard tiebreak: record first, then total points scored.
  const standings = ((rows ?? []) as StandingsRow[]).sort(
    (a, b) =>
      b.wins - a.wins ||
      a.losses - b.losses ||
      Number(b.points_for) - Number(a.points_for),
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="h1">Standings</h1>
        <p className="muted">
          Top {league.playoff_teams} make the playoffs in week{" "}
          {league.playoff_start_week}.
        </p>
      </div>

      {standings.length === 0 ? (
        <p className="card muted">
          No results yet. Standings fill in as matchups go final.
        </p>
      ) : (
        <div className="card-tight table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th className="w-8">#</th>
                <th>Team</th>
                <th className="text-right">W</th>
                <th className="text-right">L</th>
                <th className="text-right">T</th>
                <th className="text-right">PF</th>
                <th className="text-right">PA</th>
              </tr>
            </thead>
            <tbody>
              {standings.map((row, i) => {
                const inPlayoffs = i < league.playoff_teams;
                return (
                  <tr
                    key={row.team_id}
                    className={row.team_id === myTeam?.id ? "bg-surface-2" : ""}
                  >
                    <td
                      className={
                        inPlayoffs ? "font-medium text-positive" : "text-muted"
                      }
                    >
                      {i + 1}
                    </td>
                    <td>
                      <Link
                        href={`/l/${leagueId}/team/${row.team_id}`}
                        className="hover:text-accent"
                      >
                        <span className="block font-medium">{row.team_name}</span>
                        <span className="muted text-xs">
                          {row.owner_id
                            ? (ownerName.get(row.owner_id) ?? "Unclaimed")
                            : "Unclaimed"}
                        </span>
                      </Link>
                    </td>
                    <td className="text-right tabular-nums">{row.wins}</td>
                    <td className="text-right tabular-nums">{row.losses}</td>
                    <td className="text-right tabular-nums">{row.ties}</td>
                    <td className="text-right tabular-nums">
                      {Number(row.points_for).toFixed(1)}
                    </td>
                    <td className="text-right tabular-nums text-muted">
                      {Number(row.points_against).toFixed(1)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
