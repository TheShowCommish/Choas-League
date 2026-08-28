"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export interface TradeResult {
  error?: string;
  ok?: string;
}

/**
 * Proposes a trade.
 *
 * The rows go in as `pending`; nothing moves until the other manager
 * accepts, at which point execute_trade does the whole swap in one
 * transaction.
 */
export async function proposeTrade(
  leagueId: string,
  fromTeamId: string,
  toTeamId: string,
  giving: string[],
  receiving: string[],
  faabOffered: number,
  note: string,
): Promise<TradeResult> {
  if (giving.length === 0 && receiving.length === 0 && faabOffered <= 0) {
    return { error: "A trade needs at least one player or some FAAB." };
  }
  if (fromTeamId === toTeamId) {
    return { error: "You cannot trade with yourself." };
  }

  const supabase = await createClient();

  const { data: league } = await supabase
    .from("leagues")
    .select("season, current_week")
    .eq("id", leagueId)
    .single();
  if (!league) return { error: "League not found." };

  if (faabOffered > 0) {
    const { data: team } = await supabase
      .from("teams")
      .select("faab_remaining")
      .eq("id", fromTeamId)
      .single();
    if (team && faabOffered > team.faab_remaining) {
      return { error: `You only have $${team.faab_remaining} of FAAB.` };
    }
  }

  const { data: trade, error } = await supabase
    .from("trades")
    .insert({
      league_id: leagueId,
      proposing_team_id: fromTeamId,
      receiving_team_id: toTeamId,
      status: "pending",
      note: note.slice(0, 500),
      season: league.season,
      week: league.current_week,
    })
    .select("id")
    .single();

  if (error) return { error: error.message };

  // A trade item is exactly one of a player or an amount of FAAB; the
  // table has a check constraint saying so.
  interface TradeItemInsert {
    trade_id: string;
    from_team_id: string;
    player_id?: string;
    faab_amount?: number;
  }

  const items: TradeItemInsert[] = [
    ...giving.map((playerId) => ({
      trade_id: trade.id,
      from_team_id: fromTeamId,
      player_id: playerId,
    })),
    ...receiving.map((playerId) => ({
      trade_id: trade.id,
      from_team_id: toTeamId,
      player_id: playerId,
    })),
  ];

  if (faabOffered > 0) {
    items.push({
      trade_id: trade.id,
      from_team_id: fromTeamId,
      faab_amount: faabOffered,
    });
  }

  const { error: itemError } = await supabase.from("trade_items").insert(items);

  if (itemError) {
    // Do not leave an empty proposal lying around.
    await supabase.from("trades").delete().eq("id", trade.id);
    return { error: itemError.message };
  }

  revalidatePath(`/l/${leagueId}/trades`);
  return { ok: "Trade proposed." };
}

/** Accept a trade offered to you, and execute it. */
export async function acceptTrade(
  leagueId: string,
  tradeId: string,
): Promise<TradeResult> {
  const supabase = await createClient();

  const { error: statusError } = await supabase
    .from("trades")
    .update({ status: "accepted", responded_at: new Date().toISOString() })
    .eq("id", tradeId)
    .eq("status", "pending");

  if (statusError) return { error: statusError.message };

  const { error } = await supabase.rpc("execute_trade", { p_trade: tradeId });

  if (error) {
    // The swap failed -- a player may have been dropped since. Put the
    // proposal back so it is not stuck in a state nobody can act on.
    await supabase
      .from("trades")
      .update({ status: "pending", responded_at: null })
      .eq("id", tradeId);
    return { error: error.message };
  }

  revalidatePath(`/l/${leagueId}`, "layout");
  return { ok: "Trade completed." };
}

export async function respondToTrade(
  leagueId: string,
  tradeId: string,
  status: "rejected" | "cancelled",
): Promise<TradeResult> {
  const supabase = await createClient();

  const { error } = await supabase
    .from("trades")
    .update({ status, responded_at: new Date().toISOString() })
    .eq("id", tradeId)
    .eq("status", "pending");

  if (error) return { error: error.message };

  revalidatePath(`/l/${leagueId}/trades`);
  return { ok: status === "rejected" ? "Trade rejected." : "Trade cancelled." };
}
