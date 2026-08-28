import Link from "next/link";
import { getLeagueContext } from "@/lib/league";
import { createClient } from "@/lib/supabase/server";
import type { Draft, DraftPick } from "@/lib/types";
import { DraftRoom } from "./draft-room";

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

  const { data: draft } = await supabase
    .from("drafts")
    .select("*")
    .eq("league_id", leagueId)
    .maybeSingle();

  if (!draft) {
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

  const [{ data: picks }, { data: pool }, { data: queue }] = await Promise.all([
    supabase
      .from("draft_picks")
      .select("*")
      .eq("draft_id", draft.id)
      .order("pick_number"),
    // 300 covers a full draft's worth of relevant players without
    // shipping the whole 2,000-row player table to the browser.
    supabase.rpc("league_player_pool", {
      p_league: leagueId,
      p_availability: "available",
      p_sort: "points",
      p_limit: 300,
      p_offset: 0,
    }),
    myTeam
      ? supabase
          .from("draft_queue")
          .select("player_id, rank")
          .eq("team_id", myTeam.id)
          .order("rank")
      : Promise.resolve({ data: [] }),
  ]);

  return (
    <DraftRoom
      leagueId={leagueId}
      draft={draft as Draft}
      picks={(picks ?? []) as DraftPick[]}
      teams={teams}
      myTeamId={myTeam?.id ?? null}
      isCommissioner={isCommissioner}
      available={(pool ?? []) as DraftablePlayer[]}
      queuedIds={((queue ?? []) as { player_id: string }[]).map(
        (q) => q.player_id,
      )}
      seasonLabel={String(league.season)}
    />
  );
}
