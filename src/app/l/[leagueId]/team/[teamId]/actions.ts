"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export interface OverrideResult {
  error?: string;
  ok?: string;
}

/**
 * The commissioner moves one player in a team's lineup, locked or not.
 *
 * commissioner_set_lineup_slot does the checking and writes the
 * transaction log line, so every override after lock is on the record.
 */
export async function overrideLineupSlot(
  _prev: OverrideResult,
  formData: FormData,
): Promise<OverrideResult> {
  const leagueId = String(formData.get("league_id"));
  const teamId = String(formData.get("team_id"));
  const week = Number(formData.get("week"));
  const playerId = String(formData.get("player_id") ?? "");
  const slotKey = String(formData.get("slot_key") ?? "");
  const note = String(formData.get("note") ?? "").trim();

  if (!playerId) return { error: "Pick a player." };
  if (!note) return { error: "Give a reason for the override." };
  if (note.length > 200) {
    return { error: "Keep the reason to 200 characters." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("commissioner_set_lineup_slot", {
    p_team: teamId,
    p_week: week,
    p_player: playerId,
    p_slot: slotKey || null,
    p_note: note,
  });

  if (error) return { error: error.message };

  revalidatePath(`/l/${leagueId}`, "layout");
  return { ok: "Lineup changed and logged." };
}
