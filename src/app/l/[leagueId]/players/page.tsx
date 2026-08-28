import Link from "next/link";
import { getLeagueContext } from "@/lib/league";
import { getTeamRoster } from "@/lib/roster";
import { createClient } from "@/lib/supabase/server";
import type { WaiverClaim } from "@/lib/types";
import { PlayerFilters } from "./filters";
import { PlayerActions } from "./player-actions";
import { PendingClaims } from "./pending-claims";
import { SortHeader } from "./sortable";

const PAGE_SIZE = 50;

export interface PoolRow {
  player_id: string;
  full_name: string;
  pos: string | null;
  team_abbr: string | null;
  status: string | null;
  headshot_url: string | null;
  owner_team_id: string | null;
  owner_team_name: string | null;
  on_waivers: boolean;
  waiver_clears_at: string | null;
  total_points: number;
  avg_points: number;
  games: number;
  last_points: number;
  next_opponent: string | null;
  next_kickoff: string | null;
  next_is_home: boolean | null;
  total_count: number;
}

export default async function PlayersPage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string }>;
  searchParams: Promise<{
    q?: string;
    pos?: string;
    avail?: string;
    sort?: string;
    dir?: string;
    team?: string;
    page?: string;
  }>;
}) {
  const { leagueId } = await params;
  const sp = await searchParams;
  const { league, myTeam } = await getLeagueContext(leagueId);
  const supabase = await createClient();

  const page = Math.max(Number(sp.page) || 1, 1);
  const availability = sp.avail || "available";
  const sort = sp.sort || "points";
  const dir = sp.dir === "asc" ? "asc" : "desc";

  const [{ data: pool }, { data: positions }, { data: nflTeams }, { data: claims }] =
    await Promise.all([
      supabase.rpc("league_player_pool", {
        p_league: leagueId,
        p_search: sp.q || null,
        p_position: sp.pos || null,
        p_availability: availability,
        p_sort: sort,
        p_limit: PAGE_SIZE,
        p_offset: (page - 1) * PAGE_SIZE,
        p_team: sp.team || null,
        p_dir: dir,
      }),
      supabase.rpc("available_positions"),
      supabase.rpc("available_nfl_teams"),
      myTeam
        ? supabase
            .from("waiver_claims")
            .select("*")
            .eq("team_id", myTeam.id)
            .eq("status", "pending")
            .order("claim_priority")
        : Promise.resolve({ data: [] }),
    ]);

  const rows = (pool ?? []) as PoolRow[];
  const totalCount = rows[0]?.total_count ?? 0;
  const pageCount = Math.max(Math.ceil(Number(totalCount) / PAGE_SIZE), 1);

  // The manager's own roster, so add/claim can offer a matching drop.
  const myRoster = myTeam
    ? await getTeamRoster(leagueId, myTeam.id, league.season, league.current_week)
    : [];

  const dropOptions = myRoster.map((r) => ({
    playerId: r.playerId,
    label: `${r.player.full_name} (${r.player.position ?? "?"})`,
  }));

  const pendingClaims = (claims ?? []) as WaiverClaim[];
  const playerNames = new Map(rows.map((r) => [r.player_id, r.full_name]));
  for (const r of myRoster) playerNames.set(r.playerId, r.player.full_name);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="h1">Players</h1>
        <p className="muted">
          {league.waiver_type === "faab"
            ? `Blind FAAB bidding. You have $${myTeam?.faab_remaining ?? 0} left.`
            : `Waiver priority order. You are #${myTeam?.waiver_priority ?? "-"}.`}{" "}
          Nobody can see your bids until waivers process.
        </p>
      </header>

      {pendingClaims.length > 0 && (
        <PendingClaims
          leagueId={leagueId}
          claims={pendingClaims}
          playerNames={Object.fromEntries(playerNames)}
          waiverType={league.waiver_type}
        />
      )}

      <PlayerFilters
        positions={(positions ?? []).map(
          (p: { pos: string; player_count: number }) => p.pos,
        )}
        nflTeams={(nflTeams ?? []).map(
          (t: { abbr: string; player_count: number }) => t.abbr,
        )}
      />

      <p className="muted text-sm">
        {Number(totalCount).toLocaleString()} players
        {pageCount > 1 && ` · page ${page} of ${pageCount}`}
      </p>

      <div className="card-tight table-scroll">
        <table className="table">
          <thead>
            <tr>
              <SortHeader column="name" label="Player" defaultDir="asc" />
              <SortHeader column="position" label="Pos" defaultDir="asc" />
              <SortHeader column="team" label="Team" defaultDir="asc" />
              <SortHeader column="owner" label="Status" defaultDir="asc" />
              <SortHeader column="kickoff" label="Next" defaultDir="asc" />
              <SortHeader column="last" label="Last" className="text-right" />
              <SortHeader column="average" label="Avg" className="text-right" />
              <SortHeader column="points" label="Total" className="text-right" />
              <th className="w-24" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="muted py-6 text-center">
                  No players match those filters.
                </td>
              </tr>
            )}

            {rows.map((row) => (
              <tr key={row.player_id}>
                <td>
                  <Link
                    href={`/l/${leagueId}/players/${row.player_id}`}
                    className="block font-medium hover:text-accent"
                  >
                    {row.full_name}
                  </Link>
                </td>

                <td className="text-xs">{row.pos ?? "?"}</td>
                <td className="text-xs">{row.team_abbr ?? "FA"}</td>

                <td className="text-xs">
                  {row.owner_team_name ? (
                    <span className="text-muted">{row.owner_team_name}</span>
                  ) : row.on_waivers ? (
                    <span className="text-negative">Waivers</span>
                  ) : (
                    <span className="text-positive">Free agent</span>
                  )}
                </td>

                <td className="whitespace-nowrap text-xs">
                  <NextGame
                    opponent={row.next_opponent}
                    kickoff={row.next_kickoff}
                    isHome={row.next_is_home}
                  />
                </td>

                <td className="text-right tabular-nums">
                  {Number(row.last_points).toFixed(1)}
                </td>
                <td className="text-right tabular-nums">
                  {Number(row.avg_points).toFixed(1)}
                </td>
                <td className="text-right tabular-nums">
                  {Number(row.total_points).toFixed(1)}
                </td>

                <td>
                  {myTeam && !row.owner_team_id && (
                    <PlayerActions
                      leagueId={leagueId}
                      teamId={myTeam.id}
                      playerId={row.player_id}
                      playerName={row.full_name}
                      onWaivers={row.on_waivers}
                      waiverType={league.waiver_type}
                      faabRemaining={myTeam.faab_remaining}
                      dropOptions={dropOptions}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pagination page={page} pageCount={pageCount} searchParams={sp} />
    </div>
  );
}

/**
 * Next week's fixture. No row for the player's team that week means a
 * bye, which is the thing you most want to see before setting a lineup.
 */
function NextGame({
  opponent,
  kickoff,
  isHome,
}: {
  opponent: string | null;
  kickoff: string | null;
  isHome: boolean | null;
}) {
  if (!opponent) return <span className="text-negative">BYE</span>;

  return (
    <>
      <span className="block">
        {isHome ? "vs" : "@"} {opponent}
      </span>
      {kickoff && (
        <time className="muted block" dateTime={kickoff}>
          {new Date(kickoff).toLocaleString(undefined, {
            weekday: "short",
            hour: "numeric",
            minute: "2-digit",
          })}
        </time>
      )}
    </>
  );
}

function Pagination({
  page,
  pageCount,
  searchParams,
}: {
  page: number;
  pageCount: number;
  searchParams: Record<string, string | undefined>;
}) {
  if (pageCount <= 1) return null;

  const href = (p: number) => {
    const query = new URLSearchParams(
      Object.entries(searchParams).filter(([, v]) => v) as [string, string][],
    );
    query.set("page", String(p));
    return `?${query}`;
  };

  return (
    <nav className="flex items-center justify-between gap-3">
      {page > 1 ? (
        <Link href={href(page - 1)} className="btn btn-sm">
          &larr; Previous
        </Link>
      ) : (
        <span />
      )}
      <span className="muted text-sm">
        {page} / {pageCount}
      </span>
      {page < pageCount ? (
        <Link href={href(page + 1)} className="btn btn-sm">
          Next &rarr;
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
