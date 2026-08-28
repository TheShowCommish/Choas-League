import Link from "next/link";
import { getLeagueContext } from "@/lib/league";
import { getTeamRoster } from "@/lib/roster";
import { createClient } from "@/lib/supabase/server";
import type { WaiverClaim } from "@/lib/types";
import { PlayerFilters } from "./filters";
import { PlayerActions } from "./player-actions";
import { PendingClaims } from "./pending-claims";

const PAGE_SIZE = 50;

export interface PoolRow {
  player_id: string;
  full_name: string;
  pos: string | null;
  team_abbr: string | null;
  status: string | null;
  owner_team_id: string | null;
  owner_team_name: string | null;
  on_waivers: boolean;
  waiver_clears_at: string | null;
  total_points: number;
  avg_points: number;
  games: number;
  last_points: number;
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

  const [{ data: pool }, { data: positions }, { data: claims }] =
    await Promise.all([
      supabase.rpc("league_player_pool", {
        p_league: leagueId,
        p_search: sp.q || null,
        p_position: sp.pos || null,
        p_availability: availability,
        p_sort: sort,
        p_limit: PAGE_SIZE,
        p_offset: (page - 1) * PAGE_SIZE,
      }),
      supabase.rpc("available_positions"),
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
      />

      <p className="muted text-sm">
        {Number(totalCount).toLocaleString()} players
        {pageCount > 1 && ` · page ${page} of ${pageCount}`}
      </p>

      <div className="card-tight table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Player</th>
              <th>Status</th>
              <th className="text-right">Last</th>
              <th className="text-right">Avg</th>
              <th className="text-right">Total</th>
              <th className="w-24" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="muted py-6 text-center">
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
                  <span className="muted text-xs">
                    {row.pos ?? "?"} &middot; {row.team_abbr ?? "FA"}
                  </span>
                </td>

                <td className="text-xs">
                  {row.owner_team_name ? (
                    <span className="text-muted">{row.owner_team_name}</span>
                  ) : row.on_waivers ? (
                    <span className="text-negative">Waivers</span>
                  ) : (
                    <span className="text-positive">Free agent</span>
                  )}
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
