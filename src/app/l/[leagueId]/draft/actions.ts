"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { AutodraftStrategy } from "@/lib/types";

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
  targetRound: number | null = null,
): Promise<DraftResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("draft_queue")
    .upsert(
      { team_id: teamId, player_id: playerId, rank, target_round: targetRound },
      { onConflict: "team_id,player_id" },
    );

  if (error) return { error: error.message };
  return { ok: "Queued." };
}

/**
 * The earliest round a queued player may be taken in.
 *
 * Null means any round. This is what lets a manager park a round-seven
 * target in the queue during round one without autopick reaching for
 * him: until the round arrives he is skipped, and autopick moves on to
 * the next name down -- or to the best available if nobody is due.
 */
export async function setQueueRound(
  teamId: string,
  playerId: string,
  targetRound: number | null,
): Promise<DraftResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("draft_queue")
    .update({ target_round: targetRound })
    .eq("team_id", teamId)
    .eq("player_id", playerId);

  if (error) return { error: error.message };
  return { ok: "Round set." };
}

/**
 * Rewrites the whole queue order in one go.
 *
 * The client sends the list as it now reads, rather than "move this one
 * up", because a queue being reordered while a pick lands is a good way
 * to end up with two players ranked fourth.
 */
export async function reorderQueue(
  teamId: string,
  playerIds: string[],
): Promise<DraftResult> {
  if (playerIds.length === 0) return {};

  const supabase = await createClient();
  const { error } = await supabase.from("draft_queue").upsert(
    playerIds.map((playerId, index) => ({
      team_id: teamId,
      player_id: playerId,
      rank: index + 1,
    })),
    { onConflict: "team_id,player_id" },
  );

  if (error) return { error: error.message };
  return {};
}

/**
 * How autopick should choose for you once your queue runs dry.
 *
 * Stored on the team rather than per draft: it is a statement about how
 * this manager drafts, and there is one draft a season anyway. The
 * check constraint in 0036 is the real gate -- this validates first so
 * a stale tab gets a sentence rather than a constraint violation.
 */
export async function setAutodraftStrategy(
  leagueId: string,
  teamId: string,
  strategy: AutodraftStrategy,
): Promise<DraftResult> {
  const allowed: AutodraftStrategy[] = ["adp", "last_season", "projection"];
  if (!allowed.includes(strategy)) {
    return { error: "That is not an autodraft setting." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("teams")
    .update({ autodraft_strategy: strategy })
    .eq("id", teamId);

  if (error) return { error: error.message };

  revalidatePath(`/l/${leagueId}/draft`);
  return { ok: "Autodraft updated." };
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
