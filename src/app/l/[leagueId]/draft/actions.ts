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

// --- Auction ---------------------------------------------------------

export async function nominatePlayer(
  leagueId: string,
  draftId: string,
  playerId: string,
  openingBid: number,
): Promise<DraftResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("nominate_player", {
    p_draft: draftId,
    p_player: playerId,
    p_opening_bid: Math.max(1, Math.floor(openingBid)),
  });

  if (error) return { error: error.message };

  revalidatePath(`/l/${leagueId}/draft`);
  return { ok: "Nominated." };
}

export async function placeBid(
  leagueId: string,
  lotId: string,
  teamId: string,
  amount: number,
): Promise<DraftResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("place_bid", {
    p_lot: lotId,
    p_team: teamId,
    p_amount: Math.floor(amount),
  });

  if (error) return { error: error.message };

  revalidatePath(`/l/${leagueId}/draft`);
  return { ok: "Bid placed." };
}

/**
 * Awards the open lot once its clock has run out. Called from the
 * client by whoever has the room open; the RPC re-checks the deadline
 * itself, so several browsers racing to call it is harmless.
 */
export async function closeLot(
  leagueId: string,
  lotId: string,
): Promise<DraftResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("close_auction_lot", { p_lot: lotId });

  if (error) return { error: error.message };

  revalidatePath(`/l/${leagueId}/draft`);
  return {};
}
