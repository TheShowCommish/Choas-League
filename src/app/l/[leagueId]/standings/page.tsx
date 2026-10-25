import Link from "next/link";
import { getLeagueContext } from "@/lib/league";
import { DEFAULT_SEEDING_TIEBREAKERS } from "@/lib/playoff-bracket";
import { makesPlayoffs, orderStandings } from "@/lib/standings-order";
import { createClient } from "@/lib/supabase/server";
import type { Profile, StandingsRow } from "@/lib/types";
import { seedingTiebreakCaption } from "../seeding-copy";

/**
 * Win percentage, ESPN-style: wins plus half of ties over games played,
 * 0 when nobody has played. Derived here from the record rather than
 * read off the row, so the column can't disagree with W-L-T beside it.
 */
function winPct(wins: number, losses: number, ties: number): number {
  const games = wins + losses + ties;
  return games > 0 ? (wins + 0.5 * ties) / games : 0;
}

/**
 * Games back of the leader: the standard (leaderW - teamW + teamL -
 * leaderL) / 2. Zero for the leader itself (and for anyone level with
 * it), which the table renders as a dash.
 */
function gamesBack(
  leader: Pick<StandingsRow, "wins" | "losses">,
  team: Pick<StandingsRow, "wins" | "losses">,
): number {
  const gb =
    (Number(leader.wins) -
      Number(team.wins) +
      (Number(team.losses) - Number(leader.losses))) /
    2;
  return gb > 0 ? gb : 0;
}

/** GB for display: a dash at the top, whole numbers bare, halves to .5. */
function gbText(gb: number): string {
  if (gb <= 0) return "—";
  return Number.isInteger(gb) ? String(gb) : gb.toFixed(1);
}

export default async function StandingsPage({
  params,
}: {
  params: Promise<{ leagueId: string }>;
}) {
  const { leagueId } = await params;
  const { league, myTeam } = await getLeagueContext(leagueId);
  const supabase = await createClient();

  const [{ data: rows }, { data: profiles }, { data: order }] =
    await Promise.all([
      supabase.from("standings").select("*").eq("league_id", leagueId),
      supabase.from("profiles").select("id, display_name"),
      // The league's own seeding order (0041), so the table and its
      // playoff line agree with the bracket that will be generated.
      supabase.rpc("league_standings_order", { p_league: leagueId }),
    ]);

  const ownerName = new Map(
    ((profiles ?? []) as Pick<Profile, "id" | "display_name">[]).map((p) => [
      p.id,
      p.display_name,
    ]),
  );

  // Record first, then the league's own seeding tiebreakers -- the
  // same order generate_playoffs seeds from, so the top rows are the
  // teams that will actually be in the bracket.
  const seedByTeam = new Map(
    ((order ?? []) as { team_id: string; seed: number }[]).map((o) => [
      o.team_id,
      o.seed,
    ]),
  );
  const standings = orderStandings((rows ?? []) as StandingsRow[], seedByTeam);
  const leader = standings[0];
  // Only draw a cut line when the bracket actually splits the field: at
  // least one team makes it and at least one misses out.
  const cutAfter =
    league.playoff_teams > 0 && league.playoff_teams < standings.length
      ? league.playoff_teams
      : -1;

  const owner = (row: StandingsRow) =>
    row.owner_id ? (ownerName.get(row.owner_id) ?? "Unclaimed") : "Unclaimed";

  return (
    <div className="space-y-4">
      <div>
        <h1 className="h1">Standings</h1>
        <p className="muted">
          Top {league.playoff_teams} make the playoffs in week{" "}
          {league.playoff_start_week}.
        </p>
        {/* Teams level on record are ordered by the league's own seeding
            rules, so the table says which ones -- otherwise two 8-5
            teams in "the wrong order" look like a bug. */}
        <p className="mt-0.5 text-xs text-muted">
          {seedingTiebreakCaption(
            league.seeding_tiebreakers ?? DEFAULT_SEEDING_TIEBREAKERS,
          )}
        </p>
      </div>

      {standings.length === 0 ? (
        <div className="card">
          <p className="font-medium">No games played yet</p>
          <p className="muted mt-0.5">
            The table fills in as matchups go final.
          </p>
        </div>
      ) : (
        <>
          {/* Desktop: the full standings -- record, derived PCT and GB,
              points for and against, with the playoff cut line drawn
              across the table. For decisions, not a glance. */}
          <div className="card-tight hidden md:block">
            <table className="table">
              <thead>
                <tr>
                  <th className="w-8">#</th>
                  <th>Team</th>
                  <th className="text-right">W-L-T</th>
                  <th className="text-right">PCT</th>
                  <th className="text-right">GB</th>
                  <th className="text-right">PF</th>
                  <th className="text-right">PA</th>
                </tr>
              </thead>
              <tbody>
                {standings.map((row, i) => {
                  const inPlayoffs = makesPlayoffs(i, league.playoff_teams);
                  const mine = row.team_id === myTeam?.id;
                  return [
                    <tr key={row.team_id} className={mine ? "bg-surface-2" : ""}>
                      <td
                        className={
                          inPlayoffs
                            ? "score text-positive"
                            : "text-muted tabular-nums"
                        }
                      >
                        {i + 1}
                      </td>
                      <td>
                        <Link
                          href={`/l/${leagueId}/team/${row.team_id}`}
                          className="block hover:text-accent"
                        >
                          <span className="block font-medium">
                            {row.team_name}
                          </span>
                          <span className="muted text-xs">{owner(row)}</span>
                        </Link>
                      </td>
                      <td className="score text-right">
                        {Number(row.wins)}-{Number(row.losses)}-
                        {Number(row.ties)}
                      </td>
                      <td className="score text-right">
                        {winPct(
                          Number(row.wins),
                          Number(row.losses),
                          Number(row.ties),
                        ).toFixed(3)}
                      </td>
                      <td className="score text-right text-muted">
                        {leader ? gbText(gamesBack(leader, row)) : "—"}
                      </td>
                      <td className="score text-right">
                        {Number(row.points_for).toFixed(1)}
                      </td>
                      <td className="score text-right text-muted">
                        {Number(row.points_against).toFixed(1)}
                      </td>
                    </tr>,
                    cutAfter === i + 1 ? (
                      <tr key={`${row.team_id}-cut`} aria-hidden="true">
                        <td
                          colSpan={7}
                          className="border-y border-accent/40 bg-accent/5 px-2 py-1 text-center text-[10px] font-semibold tracking-wider text-accent uppercase"
                        >
                          Playoff cut line
                        </td>
                      </tr>
                    ) : null,
                  ];
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile: one scannable card per team. Rank + playoff dot,
              team and owner, then the record and points-for -- the two
              numbers a quick check wants. PCT/GB/PA live on desktop. */}
          <ul className="space-y-2 md:hidden">
            {standings.map((row, i) => {
              const inPlayoffs = makesPlayoffs(i, league.playoff_teams);
              const mine = row.team_id === myTeam?.id;
              return (
                <li key={row.team_id}>
                  <Link
                    href={`/l/${leagueId}/team/${row.team_id}`}
                    className={`card-tight flex min-h-11 items-center gap-3 p-3 ${
                      mine ? "bg-surface-2" : ""
                    }`}
                  >
                    <span className="flex w-7 shrink-0 items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className={`size-1.5 rounded-full ${
                          inPlayoffs ? "bg-positive" : "bg-transparent"
                        }`}
                      />
                      <span
                        className={`score text-base ${
                          inPlayoffs ? "text-positive" : "text-muted"
                        }`}
                      >
                        {i + 1}
                      </span>
                    </span>

                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{row.team_name}</p>
                      <p className="muted truncate text-xs">{owner(row)}</p>
                    </div>

                    <div className="flex shrink-0 items-baseline gap-3 text-right">
                      <span className="score text-base">
                        {Number(row.wins)}-{Number(row.losses)}-
                        {Number(row.ties)}
                      </span>
                      <span>
                        <span className="score text-lg leading-none">
                          {Number(row.points_for).toFixed(1)}
                        </span>
                        <span className="block text-[10px] tracking-wide text-muted uppercase">
                          PF
                        </span>
                      </span>
                    </div>
                  </Link>

                  {cutAfter === i + 1 && (
                    <div
                      aria-hidden="true"
                      className="flex items-center gap-2 px-1 pt-2"
                    >
                      <span className="h-px flex-1 bg-accent/40" />
                      <span className="text-[10px] font-semibold tracking-wider text-accent uppercase">
                        Playoff cut line
                      </span>
                      <span className="h-px flex-1 bg-accent/40" />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
