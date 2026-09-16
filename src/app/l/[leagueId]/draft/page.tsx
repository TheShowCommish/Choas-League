import Link from "next/link";
import { getLeagueContext } from "@/lib/league";
import { createClient } from "@/lib/supabase/server";
import type { AutodraftStrategy, Draft, DraftPick } from "@/lib/types";
import { DraftRoom } from "./draft-room";
import { AuctionRoom, type AuctionLot } from "./auction-room";
import { positionLabel } from "@/lib/roster-slots";

export interface DraftablePlayer {
  player_id: string;
  full_name: string;
  pos: string | null;
  team_abbr: string | null;
  total_points: number;
  adp: number | null;
  adp_rank: number | null;
  /** This season's projection, scored with this league's rules. */
  proj_points: number | null;
  injury_status: string | null;
  injury_body_part: string | null;
  bye_week: number | null;
}

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

  const [{ data: picks }, { data: pool }] = await Promise.all([
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
  ]);

  const pickRows = (picks ?? []) as DraftPick[];
  const available = (pool ?? []) as DraftablePlayer[];

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

  const { data: drafted } = draftedIds.length
    ? await supabase
        .from("nfl_players")
        .select("id, full_name, position, team_abbr")
        .in("id", draftedIds)
    : { data: [] };

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
  // looking him up in a pool he may have already left.
  let queue: QueueEntry[] = [];

  if (myTeam) {
    const { data: queueRows } = await supabase
      .from("draft_queue")
      .select("player_id, rank, target_round")
      .eq("team_id", myTeam.id)
      .order("rank");

    const rows = (queueRows ?? []) as {
      player_id: string;
      rank: number;
      target_round: number | null;
    }[];

    if (rows.length > 0) {
      const { data: queuedPlayers } = await supabase
        .from("nfl_players")
        .select("id, full_name, position, team_abbr, adp")
        .in(
          "id",
          rows.map((r) => r.player_id),
        );

      const byId = new Map(
        (queuedPlayers ?? []).map((p) => [p.id as string, p]),
      );

      queue = rows.map((row) => {
        const player = byId.get(row.player_id);
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
    }
  }

  /*
   * Who autopick would take for you, if your clock ran out.
   *
   * Asked of the database rather than worked out here, because the
   * database is what will actually make the pick -- a second
   * implementation in TypeScript would be a second set of rules to
   * drift. It answers only about your own team: a queue is private, and
   * its top name is the most valuable thing in it.
   *
   * Resolved for the round of your next pick, not the round the room is
   * in, so a target round that has not arrived yet reads correctly.
   */
  const myNextPick = myTeam
    ? pickRows.find(
        (p) =>
          p.team_id === myTeam.id &&
          p.pick_number >= draft.current_pick_number &&
          !p.player_id,
      )
    : undefined;

  let autopickName: string | null = null;

  // No pick left to make means nothing for autopick to do, and no round
  // to resolve a target against -- so there is nothing to ask about.
  if (myTeam && myNextPick && draft.status !== "complete") {
    const { data: candidateId } = await supabase.rpc("autopick_candidate", {
      p_draft: draft.id,
      p_team: myTeam.id,
      p_round: myNextPick.round,
    });

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
