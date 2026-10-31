"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

/**
 * Mark one alert read. The client passes only the id; RLS limits the
 * update to the caller's own rows in a league they belong to, so there is
 * nothing to authorise here that it does not already enforce.
 */
export async function markRead(leagueId: string, id: string): Promise<void> {
  const supabase = await createClient();
  await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id)
    .is("read_at", null);

  // The badge lives in the layout, so re-render it along with the list.
  revalidatePath(`/l/${leagueId}`, "layout");
}

/** Mark every unread alert in this league read. */
export async function markAllRead(leagueId: string): Promise<void> {
  const supabase = await createClient();
  await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("league_id", leagueId)
    .is("read_at", null);

  revalidatePath(`/l/${leagueId}`, "layout");
}
