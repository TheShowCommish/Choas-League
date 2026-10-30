import Link from "next/link";
import { getLeagueContext } from "@/lib/league";
import { createClient } from "@/lib/supabase/server";
import type { AutodraftStrategy, Draft, DraftPick } from "@/lib/types";
import { toDraftablePlayer, type PoolRpcRow } from "@/lib/draft-pool";
import { DraftRoom } from "./draft-room";
import { AuctionRoom, type AuctionLot } from "./auction-room";
import { positionLabel } from "@/lib/roster-slots";

// The board and the auction floor import the player shape from here; it
// now lives alongside the slimming mapper that produces it.
export type { DraftablePlayer } from "@/lib/draft-pool";

/** Enough about a drafted player to render him on the board. */
export interface PickedPlayer {
  id: string;
  full_name: string;
  position: string | null;
  team_abbr: string | null;
}

export interface QueueEntry {
  player_id: string;
  rank: number;
  target_round: number | null;
  full_name: string;
  position: string | null;
  team_abbr: string | null;
  adp: number | null;
}

/**
 * The board ships this many available players to the browser.
 *
 * Search and the position filter run in the client so they are instant,
 * which means the list has to be long enough to contain anybody worth
 * searching for. Five hundred is roughly two full drafts' worth.
 */
const POOL_SIZE = 500;

export default async function DraftPage({
  params,
}: {
  params: Promise<{ leagueId: string }>;
}) {
  const { leagueId } = await params;
  const { league, teams, myTeam, isCommissioner, rosterSlots } =
    await getLeagueContext(leagueId);
  const supabase = await createClient();

  const { data: draftRow } = await supabase
    .from("drafts")
    .select("*")
    .eq("league_id", leagueId)
    .maybeSingle();

  if (!draftRow) {
    return (
      <div className="card">
        <h1 className="h1 mb-2">No draft yet</h1>
        <p className="muted mb-3">
          {isCommissioner
            ? "Generate the draft board from the admin page when you are ready."
            : "Your commissioner has not set up the draft yet."}
        </p>
        {isCommissioner && (
          <Link href={`/l/${leagueId}/admin`} className="btn btn-primary">
            Open admin
          </Link>
        )}
      </div>
    );
  }

  const draft = draftRow as Draft;

  // The picks, the pool and the manager's queue rows have no dependency
  // on one another, so they open together. (The queue is empty for an
  // auction, where there is no queue.)
  const [{ data: picks }, { data: pool }, { data: queueRowsRaw }] =
    await Promise.all([
      supabase
        .from("draft_picks")
        .select("*")
        .eq("draft_id", draft.id)
        .order("pick_number"),
      supabase.rpc("league_player_pool", {
        p_league: leagueId,
        p_availability: "available",
        // The board opens in the order the room is drafting, not in order
        // of last season's points.
        p_sort: "adp",
        p_limit: POOL_SIZE,
        p_offset: 0,
      }),
      myTeam
        ? supabase
            .from("draft_queue")
            .select("player_id, rank, target_round")
            .eq("team_id", myTeam.id)
            .order("rank")
        : Promise.resolve({ data: [] }),
    ]);

  const pickRows = (picks ?? []) as DraftPick[];
  // A projection, not a cast: keep only the eleven columns the room
  // renders rather than serialising all two dozen the RPC returns for
  // every one of the 500 players (see toDraftablePlayer).
  const available = ((pool ?? []) as PoolRpcRow[]).map(toDraftablePlayer);

  const queueRows = (queueRowsRaw ?? []) as {
    player_id: string;
    rank: number;
    target_round: number | null;
  }[];

  /*
   * Names for everybody already drafted.
   *
   * These cannot come from the available pool -- being drafted is
   * exactly what takes a player out of it -- which is why the board used
   * to fall back to printing raw gsis ids like "00-0036223".
   */
  const draftedIds = pickRows
    .map((p) => p.player_id)
    .filter((id): id is string => !!id);

  /*
   * Who autopick would take for you, if your clock ran out. Resolved for
   * the round of your *next* pick (snake only), so a target round that
   * has not arrived yet reads correctly. Skipped once the draft is
   * complete: no pick to make, no round to resolve against.
   */
  const myNextPick =
    myTeam && draft.type !== "auction"
      ? pickRows.find(
          (p) =>
            p.team_id === myTeam.id &&
            p.pick_number >= draft.current_pick_number &&
            !p.player_id,
        )
      : undefined;
  const wantAutopick = !!(myTeam && myNextPick && draft.status !== "complete");

  /*
   * Everything that depends only on the first batch runs in the second,
   * in parallel: the drafted players' names, the queued players' names
   * and -- asked of the database rather than reimplemented here, since
   * the database is what actually makes the pick -- what autopick would
   * reach for.
   */
  const [{ data: drafted }, { data: queuedPlayers }, { data: candidateId }] =
    await Promise.all([
      draftedIds.length
        ? supabase
            .from("nfl_players")
            .select("id, full_name, position, team_abbr")
            .in("id", draftedIds)
        : Promise.resolve({ data: [] }),
      queueRows.length
        ? supabase
            .from("nfl_players")
            .select("id, full_name, position, team_abbr, adp")
            .in(
              "id",
              queueRows.map((r) => r.player_id),
            )
        : Promise.resolve({ data: [] }),
      wantAutopick && myTeam && myNextPick
        ? supabase.rpc("autopick_candidate", {
            p_draft: draft.id,
            p_team: myTeam.id,
            p_round: myNextPick.round,
          })
        : Promise.resolve({ data: null }),
    ]);

  const pickedPlayers = (drafted ?? []) as PickedPlayer[];

  if (draft.type === "auction") {
    const [{ data: lot }, { data: nominator }, { data: maxBid }] =
      await Promise.all([
        supabase
          .from("auction_lots")
          .select("id, player_id, nominated_by, high_bid, high_bidder_id, status, closes_at")
          .eq("draft_id", draft.id)
          .eq("status", "open")
          .maybeSingle(),
        supabase.rpc("auction_nominator", { p_draft: draft.id }),
        myTeam
          ? supabase.rpc("auction_max_bid", {
              p_draft: draft.id,
              p_team: myTeam.id,
            })
          : Promise.resolve({ data: 0 }),
      ]);

    // Budgets are derived from picks won rather than stored, so they
    // cannot drift out of step with what was actually spent.
    const budgets: Record<string, number> = {};
    for (const team of teams) {
      const spent = pickRows
        .filter((p) => p.team_id === team.id)
        .reduce((sum, p) => sum + (p.bid_amount ?? 0), 0);
      budgets[team.id] = draft.auction_budget - spent;
    }

    return (
      <AuctionRoom
        leagueId={leagueId}
        draft={draft}
        picks={pickRows}
        teams={teams}
        myTeamId={myTeam?.id ?? null}
        isCommissioner={isCommissioner}
        available={available}
        pickedPlayers={pickedPlayers}
        openLot={(lot ?? null) as AuctionLot | null}
        nominatorId={(nominator as string | null) ?? null}
        budgets={budgets}
        maxBid={Number(maxBid ?? 0)}
        seasonLabel={String(league.season)}
      />
    );
  }

  // The queue, with enough about each player to render him without
  // looking him up in a pool he may have already left. Built from the
  // rows and names fetched in the two batches above.
  const queuedById = new Map(
    (queuedPlayers ?? []).map((p) => [p.id as string, p]),
  );
  const queue: QueueEntry[] = queueRows.map((row) => {
    const player = queuedById.get(row.player_id);
    return {
      player_id: row.player_id,
      rank: row.rank,
      target_round: row.target_round,
      full_name: (player?.full_name as string) ?? row.player_id,
      position: (player?.position as string | null) ?? null,
      team_abbr: (player?.team_abbr as string | null) ?? null,
      adp: player?.adp === undefined ? null : Number(player.adp),
    };
  });

  // The candidate id came back in the second batch; one last lookup
  // turns it into the name the room shows.
  let autopickName: string | null = null;
  if (candidateId) {
    const { data: candidate } = await supabase
      .from("nfl_players")
      .select("full_name, position, team_abbr")
      .eq("id", candidateId as string)
      .maybeSingle();

    autopickName = candidate
      ? `${candidate.full_name} (${positionLabel(candidate.position)} · ${
          candidate.team_abbr ?? "FA"
        })`
      : null;
  }

  return (
    <DraftRoom
      leagueId={leagueId}
      draft={draft}
      picks={pickRows}
      teams={teams}
      myTeamId={myTeam?.id ?? null}
      isCommissioner={isCommissioner}
      available={available}
      pickedPlayers={pickedPlayers}
      queue={queue}
      rosterSlots={rosterSlots}
      seasonLabel={String(league.season)}
      autodraftStrategy={
        (myTeam?.autodraft_strategy as AutodraftStrategy) ?? "adp"
      }
      autopickName={autopickName}
    />
  );
}
