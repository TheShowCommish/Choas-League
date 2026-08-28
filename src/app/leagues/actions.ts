"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export interface ActionResult {
  error?: string;
}

/** The NFL season a league created today most likely belongs to. */
function currentSeason(): number {
  const now = new Date();
  // A new league started in Jan-Jun is for the season that just ended.
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
}

export async function createLeague(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const name = String(formData.get("name") ?? "").trim();
  const teamName = String(formData.get("team_name") ?? "").trim();
  const season = Number(formData.get("season")) || currentSeason();
  const teamCount = Number(formData.get("team_count")) || 10;

  if (!name) return { error: "Give the league a name." };
  if (teamCount < 2 || teamCount > 32) {
    return { error: "A league has between 2 and 32 teams." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  // The teams are seeded by a trigger as this row lands, so team_count
  // has to be part of the insert rather than a follow-up update.
  const { data: league, error } = await supabase
    .from("leagues")
    .insert({ name, season, commissioner_id: user.id, team_count: teamCount })
    .select("id, join_code")
    .single();

  if (error) {
    return {
      error: error.message.includes("duplicate")
        ? "You already have a league with that name this season."
        : error.message,
    };
  }

  // Triggers add the membership row and the league's teams; this claims
  // the first one for the commissioner. An empty name keeps "Team 1",
  // which they can change later like anybody else.
  const { error: joinError } = await supabase.rpc("join_league", {
    p_join_code: league.join_code,
    p_team_name: teamName,
  });
  if (joinError) return { error: joinError.message };

  revalidatePath("/leagues");
  redirect(`/l/${league.id}/admin`);
}

export async function joinLeague(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const code = String(formData.get("join_code") ?? "").trim();
  const teamName = String(formData.get("team_name") ?? "").trim();

  if (!code) return { error: "Enter the join code your commissioner gave you." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("join_league", {
    p_join_code: code,
    p_team_name: teamName,
  });

  if (error) return { error: error.message };

  revalidatePath("/leagues");
  return {};
}
