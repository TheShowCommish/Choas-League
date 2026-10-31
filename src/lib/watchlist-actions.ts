"use server";

/**
 * The watchlist's one write (T-074): a star toggle for the signed-in user.
 *
 * Reachable via direct POST, so it verifies the caller is signed in and
 * leans on RLS (0045) to scope every write to that user's own rows in a
 * league they belong to. Best-effort by design: a failure is reported for
 * a quiet non-fatal message, never thrown, so a page never crashes on it.
 */

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export interface WatchToggleResult {
  /** The new state: true if the player is now watched, false if removed. */
  watching?: boolean;
  /** A non-fatal message to surface; the page must not crash on failure. */
  error?: string;
}

/**
 * Star or unstar a player for the signed-in user in this league: insert
 * when absent, delete when present. Membership and ownership are enforced
 * by RLS, so a failure is reported, never thrown.
 */
export async function toggleWatch(
  leagueId: string,
  playerId: string,
): Promise<WatchToggleResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sign in to use your watchlist." };

  const { data: existing } = await supabase
    .from("player_watchlist")
    .select("id")
    .eq("league_id", leagueId)
    .eq("user_id", user.id)
    .eq("player_id", playerId)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from("player_watchlist")
      .delete()
      .eq("id", existing.id);
    if (error) return { error: "Could not update your watchlist." };
    revalidateWatch(leagueId, playerId);
    return { watching: false };
  }

  const { error } = await supabase.from("player_watchlist").insert({
    league_id: leagueId,
    user_id: user.id,
    player_id: playerId,
  });
  if (error) {
    // A double-tap race hits the unique index; treat it as already watched
    // rather than an error the manager has to think about.
    if (error.code === "23505") {
      revalidateWatch(leagueId, playerId);
      return { watching: true };
    }
    return { error: "Could not update your watchlist." };
  }
  revalidateWatch(leagueId, playerId);
  return { watching: true };
}

function revalidateWatch(leagueId: string, playerId: string): void {
  revalidatePath(`/l/${leagueId}/players`);
  revalidatePath(`/l/${leagueId}/players/${playerId}`);
  revalidatePath(`/l/${leagueId}/watchlist`);
}
