"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export interface DraftResult {
  error?: string;
  ok?: string;
}

export async function makePick(
  leagueId: string,
  draftId: string,
  playerId: string,
): Promise<DraftResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("make_draft_pick", {
    p_draft: draftId,
    p_player: playerId,
  });

  if (error) return { error: error.message };

  revalidatePath(`/l/${leagueId}/draft`);
  return { ok: "Pick made." };
}

/**
 * Fires the autopick when a clock has expired. Called from the client by
 * whoever has the draft room open; the RPC itself re-checks the deadline
 * server-side, so several browsers racing to call it is harmless.
 */
export async function runAutopick(
  leagueId: string,
  draftId: string,
): Promise<DraftResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("autopick", { p_draft: draftId });

  if (error) return { error: error.message };

  revalidatePath(`/l/${leagueId}/draft`);
  return {};
}

export async function queuePlayer(
  teamId: string,
  playerId: string,
  rank: number,
): Promise<DraftResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("draft_queue")
    .upsert(
      { team_id: teamId, player_id: playerId, rank },
      { onConflict: "team_id,player_id" },
    );

  if (error) return { error: error.message };
  return { ok: "Queued." };
}

export async function unqueuePlayer(
  teamId: string,
  playerId: string,
): Promise<DraftResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("draft_queue")
    .delete()
    .eq("team_id", teamId)
    .eq("player_id", playerId);

  if (error) return { error: error.message };
  return {};
}
