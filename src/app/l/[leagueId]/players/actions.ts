"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export interface PlayerActionResult {
  error?: string;
  ok?: string;
}

/** Add a free agent straight to the roster, optionally dropping someone. */
export async function addFreeAgent(
  leagueId: string,
  teamId: string,
  playerId: string,
  dropPlayerId: string | null,
): Promise<PlayerActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("add_free_agent", {
    p_team: teamId,
    p_player: playerId,
    p_drop_player: dropPlayerId,
  });

  if (error) return { error: error.message };

  revalidatePath(`/l/${leagueId}/players`);
  revalidatePath(`/l/${leagueId}/my-team`);
  return { ok: "Player added." };
}

/**
 * Put in a blind waiver bid. Nobody else can see it until waivers run --
 * that is enforced by the RLS policy on waiver_claims, not here.
 */
export async function placeWaiverClaim(
  leagueId: string,
  teamId: string,
  playerId: string,
  bid: number,
  dropPlayerId: string | null,
): Promise<PlayerActionResult> {
  const supabase = await createClient();

  const { data: league } = await supabase
    .from("leagues")
    .select("season, current_week, faab_budget, min_bid, waiver_type")
    .eq("id", leagueId)
    .single();

  if (!league) return { error: "League not found." };

  const amount = Math.floor(bid);
  if (league.waiver_type === "faab") {
    if (!Number.isFinite(amount) || amount < 0) {
      return { error: "Enter a bid of zero or more." };
    }
    if (amount < league.min_bid) {
      return { error: `The minimum bid in this league is $${league.min_bid}.` };
    }

    const { data: team } = await supabase
      .from("teams")
      .select("faab_remaining")
      .eq("id", teamId)
      .single();

    if (team && amount > team.faab_remaining) {
      return { error: `You only have $${team.faab_remaining} of FAAB left.` };
    }
  }

  const { error } = await supabase.from("waiver_claims").insert({
    league_id: leagueId,
    team_id: teamId,
    add_player_id: playerId,
    drop_player_id: dropPlayerId,
    bid_amount: league.waiver_type === "faab" ? amount : 0,
    season: league.season,
    week: league.current_week,
    status: "pending",
  });

  if (error) {
    return {
      error: error.code === "23505"
        ? "You already have a pending claim on that player."
        : error.message,
    };
  }

  revalidatePath(`/l/${leagueId}/players`);
  return { ok: "Claim submitted." };
}

export async function cancelWaiverClaim(
  leagueId: string,
  claimId: string,
): Promise<PlayerActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("waiver_claims")
    .delete()
    .eq("id", claimId);

  if (error) return { error: error.message };

  revalidatePath(`/l/${leagueId}/players`);
  return { ok: "Claim cancelled." };
}
