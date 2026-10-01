"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { planLineupSave, type SaveSlot } from "@/lib/lineup";

export interface LineupResult {
  error?: string;
  ok?: string;
}

/**
 * Saves a team's lineup for one week.
 *
 * A player whose game has kicked off (or, in a weekly_kickoff league,
 * everybody once the week's first game has) cannot move into or out of
 * a starting slot. The database refuses that whatever path the write
 * takes (0042); this checks first so the message names the player, and
 * writes only the rows that changed, so a locked starter who stays put
 * is never touched. A locked player the form did not send -- his
 * controls are disabled -- simply stays where he is.
 */
export async function saveLineup(
  _prev: LineupResult,
  formData: FormData,
): Promise<LineupResult> {
  const leagueId = String(formData.get("league_id"));
  const teamId = String(formData.get("team_id"));
  const week = Number(formData.get("week"));
  const season = Number(formData.get("season"));

  const supabase = await createClient();

  // player_id -> slot_key, as submitted.
  const submitted = new Map<string, string>();
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("slot__")) {
      submitted.set(key.slice("slot__".length), String(value));
    }
  }

  const [
    { data: league },
    { data: slots },
    { data: lineup },
    { data: roster },
    { data: locks, error: locksError },
  ] = await Promise.all([
    supabase
      .from("leagues")
      .select("lineup_lock_mode")
      .eq("id", leagueId)
      .maybeSingle(),
    supabase
      .from("roster_slots")
      .select("slot_key, count, is_starter, eligible_positions")
      .eq("league_id", leagueId),
    supabase
      .from("lineup_entries")
      .select("player_id, slot_key, nfl_players(full_name)")
      .eq("team_id", teamId)
      .eq("season", season)
      .eq("week", week),
    supabase
      .from("roster_players")
      .select("player_id, nfl_players(position, full_name)")
      .eq("team_id", teamId)
      .is("dropped_at", null),
    supabase.rpc("lineup_locks", {
      p_team: teamId,
      p_season: season,
      p_week: week,
    }),
  ]);

  if (!slots || !league) return { error: "Could not read the roster settings." };
  if (locksError) return { error: locksError.message };

  const names = new Map<string, string>();
  const current = new Map<string, string>();
  for (const row of lineup ?? []) {
    const player = row.nfl_players as unknown as { full_name: string } | null;
    current.set(row.player_id as string, row.slot_key as string);
    if (player) names.set(row.player_id as string, player.full_name);
  }

  const positionOf = new Map<string, string | null>();
  for (const row of roster ?? []) {
    const player = row.nfl_players as unknown as {
      position: string | null;
      full_name: string;
    } | null;
    positionOf.set(row.player_id as string, player?.position ?? null);
    if (player) names.set(row.player_id as string, player.full_name);
  }

  const locked = new Set(
    ((locks ?? []) as { player_id: string; locked: boolean }[])
      .filter((l) => l.locked)
      .map((l) => l.player_id),
  );

  const plan = planLineupSave({
    week,
    lockMode: league.lineup_lock_mode as "per_player" | "weekly_kickoff",
    slots: slots as SaveSlot[],
    current,
    locked,
    roster: positionOf,
    names,
    submitted,
  });

  if ("error" in plan) return { error: plan.error };

  // Whoever comes out of the lineup altogether goes first, then one
  // upsert, so a swap lands whole or not at all. The order matters when
  // a save straddles a kickoff: if the database refuses the second
  // write, the first can only have left a slot short, never overfilled
  // it -- the other way round, a player moved in could land while the
  // one he replaced was refused on his way out.
  if (plan.deletes.length > 0) {
    const { error } = await supabase
      .from("lineup_entries")
      .delete()
      .eq("team_id", teamId)
      .eq("season", season)
      .eq("week", week)
      .in("player_id", plan.deletes);
    if (error) return { error: error.message };
  }

  if (plan.upserts.length > 0) {
    const { error } = await supabase.from("lineup_entries").upsert(
      plan.upserts.map(({ playerId, slotKey }) => ({
        league_id: leagueId,
        team_id: teamId,
        season,
        week,
        player_id: playerId,
        slot_key: slotKey,
      })),
      { onConflict: "team_id,season,week,player_id" },
    );
    if (error) return { error: error.message };
  }

  revalidatePath(`/l/${leagueId}/my-team`);
  return { ok: "Lineup saved." };
}

/**
 * Drop a player from the signed-in manager's roster.
 *
 * Takes plain arguments rather than FormData: the Drop buttons live
 * inside the lineup form, and a form-per-row would mean duplicate
 * field names (nested forms being invalid HTML).
 */
export async function dropPlayerById(
  leagueId: string,
  teamId: string,
  playerId: string,
): Promise<LineupResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("drop_player", {
    p_team: teamId,
    p_player: playerId,
  });

  if (error) return { error: error.message };

  revalidatePath(`/l/${leagueId}/my-team`);
  return { ok: "Player dropped." };
}

/**
 * Your team's identity: name, city, short code, colours and logo.
 *
 * Named for what it started as. The colour pair and the logo ride the
 * same form because they are edited together, in one panel, and saving
 * half a team's identity is not a thing anybody wants.
 */
export async function renameTeam(
  _prev: LineupResult,
  formData: FormData,
): Promise<LineupResult> {
  const leagueId = String(formData.get("league_id"));
  const teamId = String(formData.get("team_id"));
  const name = String(formData.get("name") ?? "").trim();
  const city = String(formData.get("city") ?? "").trim();
  const abbreviation = String(formData.get("abbreviation") ?? "")
    .trim()
    .toUpperCase();
  const color = String(formData.get("color") ?? "").trim();
  const secondary = String(formData.get("secondary_color") ?? "").trim();
  const logoUrl = String(formData.get("logo_url") ?? "").trim();

  if (!name) return { error: "A team needs a name." };

  const hex = /^#[0-9a-fA-F]{6}$/;
  if (color && !hex.test(color)) {
    return { error: "Pick a main colour, or leave it alone." };
  }
  if (secondary && !hex.test(secondary)) {
    return { error: "Pick an accent colour, or leave it alone." };
  }

  // Anything that ends up in an <img src>. Blocking javascript: and
  // data: here keeps a pasted URL from becoming an injection vector.
  if (logoUrl && !/^https:\/\//i.test(logoUrl)) {
    return { error: "A logo link has to start with https://" };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("teams")
    .update({
      name,
      city: city.slice(0, 60),
      abbreviation: abbreviation.slice(0, 5),
      ...(color ? { color } : {}),
      ...(secondary ? { secondary_color: secondary } : {}),
      logo_url: logoUrl || null,
    })
    .eq("id", teamId);

  if (error) return { error: error.message };

  revalidatePath(`/l/${leagueId}`, "layout");
  return { ok: "Team saved." };
}

/** Take one of the league's unclaimed teams. */
export async function claimTeam(
  leagueId: string,
  teamId: string,
  teamName: string,
): Promise<LineupResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("claim_team", {
    p_team: teamId,
    p_team_name: teamName.trim() || null,
  });

  if (error) return { error: error.message };

  revalidatePath(`/l/${leagueId}`, "layout");
  return { ok: "Team claimed." };
}
