import Link from "next/link";
import { getLeagueContext } from "@/lib/league";
import { createClient } from "@/lib/supabase/server";
import type { Draft, DraftPick } from "@/lib/types";
import { DraftRoom } from "./draft-room";
import { AuctionRoom, type AuctionLot } from "./auction-room";

export interface DraftablePlayer {
  player_id: string;
  full_name: string;
  pos: string | null;
  team_abbr: string | null;
  total_points: number;
}

export default async function DraftPage({
  params,
}: {
  params: Promise<{ leagueId: string }>;
}) {
  const { leagueId } = await params;
  const { league, teams, myTeam, isCommissioner } =
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
    // 300 covers a full draft's worth of relevant players without
    // shipping the whole player table to the browser.
    supabase.rpc("league_player_pool", {
      p_league: leagueId,
      p_availability: "available",
      p_sort: "points",
      p_limit: 300,
      p_offset: 0,
    }),
  ]);

  const pickRows = (picks ?? []) as DraftPick[];
  const available = (pool ?? []) as DraftablePlayer[];

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
        openLot={(lot ?? null) as AuctionLot | null}
        nominatorId={(nominator as string | null) ?? null}
        budgets={budgets}
        maxBid={Number(maxBid ?? 0)}
        seasonLabel={String(league.season)}
      />
    );
  }

  const { data: queue } = myTeam
    ? await supabase
        .from("draft_queue")
        .select("player_id, rank")
        .eq("team_id", myTeam.id)
        .order("rank")
    : { data: [] };

  return (
    <DraftRoom
      leagueId={leagueId}
      draft={draft}
      picks={pickRows}
      teams={teams}
      myTeamId={myTeam?.id ?? null}
      isCommissioner={isCommissioner}
      available={available}
      queuedIds={((queue ?? []) as { player_id: string }[]).map(
        (q) => q.player_id,
      )}
      seasonLabel={String(league.season)}
    />
  );
}
