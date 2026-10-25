import Link from "next/link";
import { getLeagueContext } from "@/lib/league";
import { getTeamRoster } from "@/lib/roster";
import { createClient } from "@/lib/supabase/server";
import { positionLabel } from "@/lib/roster-slots";
import type { Team, WaiverClaim } from "@/lib/types";
import { NflCrest } from "../nfl-crest";
import { PlayerFilters } from "./filters";
import { PlayerActions } from "./player-actions";
import { PendingClaims } from "./pending-claims";
import { AvailabilityChip, Headshot } from "./player-bits";
import { SortHeader } from "./sortable";
import { WaiverFab, type AddablePlayer } from "./waiver-fab";

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
  const { league, myTeam, teams } = await getLeagueContext(leagueId);
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
      // fantasy_positions rather than available_positions: the menu
      // should offer the positions a league can roster, not every
      // position the NFL employs.
      supabase.rpc("fantasy_positions"),
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

  // A dropped player still locked into the week cannot be dropped again.
  const dropOptions = myRoster.filter((r) => r.onRoster).map((r) => ({
    playerId: r.playerId,
    label: `${r.player.full_name} (${positionLabel(r.player.position)})`,
  }));

  // Crests for the availability chip: the pool RPC returns the owning
  // team's id and name, and the league context already has the rest.
  const teamById = new Map(teams.map((t) => [t.id, t] as const));
  const ownerTeam = (row: PoolRow): Team | null =>
    row.owner_team_id ? (teamById.get(row.owner_team_id) ?? null) : null;

  const pendingClaims = (claims ?? []) as WaiverClaim[];
  const playerNames = new Map(rows.map((r) => [r.player_id, r.full_name]));
  for (const r of myRoster) playerNames.set(r.playerId, r.player.full_name);

  // The phone's Add sheet lists the players you can actually act on.
  const addable: AddablePlayer[] = myTeam
    ? rows
        .filter((r) => !r.owner_team_id)
        .map((r) => ({
          player_id: r.player_id,
          full_name: r.full_name,
          pos: r.pos,
          team_abbr: r.team_abbr,
          on_waivers: r.on_waivers,
          headshot_url: r.headshot_url,
        }))
    : [];

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

      {rows.length === 0 ? (
        <div className="card-tight p-6">
          <p className="muted text-center">No players match those filters.</p>
        </div>
      ) : (
        <>
          {/* Desktop: the dense, sortable, full-width table. */}
          <div className="card-tight table-scroll hidden md:block">
            <table className="table">
              {/*
                Only the three number columns sort. The other five sorted
                the whole pool by a field nobody wants ranked -- surname,
                or which NFL club a man plays for. What people sort by is
                production.
              */}
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Pos</th>
                  <th>Team</th>
                  <th>Availability</th>
                  <th>Next</th>
                  <SortHeader column="last" label="Last" className="text-right" />
                  <SortHeader column="average" label="Avg" className="text-right" />
                  <SortHeader column="points" label="Total" className="text-right" />
                  <th className="w-20" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.player_id}>
                    <td>
                      <Link
                        href={`/l/${leagueId}/players/${row.player_id}`}
                        className="flex items-center gap-2.5 font-medium hover:text-accent"
                      >
                        <Headshot
                          url={row.headshot_url}
                          name={row.full_name}
                          size={28}
                        />
                        <span className="truncate">{row.full_name}</span>
                      </Link>
                    </td>

                    <td className="text-xs">{positionLabel(row.pos)}</td>

                    <td className="text-xs">
                      <span className="flex items-center gap-1.5">
                        <NflCrest abbr={row.team_abbr} />
                        <span>{row.team_abbr ?? "FA"}</span>
                      </span>
                    </td>

                    <td className="text-xs">
                      <AvailabilityChip
                        team={ownerTeam(row)}
                        ownerName={row.owner_team_name}
                        onWaivers={row.on_waivers}
                      />
                    </td>

                    <td className="whitespace-nowrap text-xs">
                      <NextGame
                        opponent={row.next_opponent}
                        kickoff={row.next_kickoff}
                        isHome={row.next_is_home}
                      />
                    </td>

                    <td className="text-right">
                      <span className="score">
                        {Number(row.last_points).toFixed(1)}
                      </span>
                    </td>
                    <td className="text-right">
                      <span className="score">
                        {Number(row.avg_points).toFixed(1)}
                      </span>
                    </td>
                    <td className="text-right">
                      <span className="score">
                        {Number(row.total_points).toFixed(1)}
                      </span>
                    </td>

                    <td className="text-right">
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

          {/* Mobile: a card per player. Read-first -- tap through to the
              player page; adding is the FAB's job. */}
          <ul className="space-y-2 md:hidden">
            {rows.map((row) => (
              <li key={row.player_id}>
                <Link
                  href={`/l/${leagueId}/players/${row.player_id}`}
                  className="card-tight flex items-center gap-3 p-3"
                >
                  <Headshot url={row.headshot_url} name={row.full_name} size={40} />

                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{row.full_name}</p>
                    <p className="muted truncate text-xs">
                      {positionLabel(row.pos)}
                      {row.team_abbr ? ` · ${row.team_abbr}` : ""}
                      {" · "}
                      {row.next_opponent
                        ? `${row.next_is_home ? "vs" : "@"} ${row.next_opponent}`
                        : "BYE"}
                    </p>
                    <div className="mt-1.5">
                      <AvailabilityChip
                        team={ownerTeam(row)}
                        ownerName={row.owner_team_name}
                        onWaivers={row.on_waivers}
                      />
                    </div>
                  </div>

                  <div className="flex shrink-0 gap-3 text-right">
                    <Stat label="Avg" value={row.avg_points} />
                    <Stat label="Total" value={row.total_points} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      <Pagination page={page} pageCount={pageCount} searchParams={sp} />

      {myTeam && (
        <WaiverFab
          leagueId={leagueId}
          teamId={myTeam.id}
          waiverType={league.waiver_type}
          faabRemaining={myTeam.faab_remaining}
          dropOptions={dropOptions}
          players={addable}
        />
      )}
    </div>
  );
}

/** One stacked number on a mobile card: the figure over its label. */
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="score text-lg leading-none">
        {Number(value).toFixed(1)}
      </div>
      <div className="text-[10px] tracking-wide text-muted uppercase">
        {label}
      </div>
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
        <Link href={href(page - 1)} className="btn">
          &larr; Previous
        </Link>
      ) : (
        <span />
      )}
      <span className="muted text-sm">
        {page} / {pageCount}
      </span>
      {page < pageCount ? (
        <Link href={href(page + 1)} className="btn">
          Next &rarr;
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
