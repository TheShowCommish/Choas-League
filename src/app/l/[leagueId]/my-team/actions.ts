"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export interface LineupResult {
  error?: string;
  ok?: string;
}

/**
 * Replaces a team's lineup for one week.
 *
 * Locked entries (their NFL game has started) are left exactly as they
 * are: we never delete them, and any assignment the client sends for a
 * locked player is ignored rather than rejected, so a stale tab cannot
 * quietly undo a lock.
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
  const assignments = new Map<string, string>();
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("slot__")) {
      assignments.set(key.slice("slot__".length), String(value));
    }
  }

  const [{ data: slots }, { data: locked }, { data: roster }] = await Promise.all([
    supabase
      .from("roster_slots")
      .select("slot_key, count, is_starter, eligible_positions")
      .eq("league_id", leagueId),
    supabase
      .from("lineup_entries")
      .select("player_id, slot_key")
      .eq("team_id", teamId)
      .eq("season", season)
      .eq("week", week)
      .not("locked_at", "is", null),
    supabase
      .from("roster_players")
      .select("player_id, nfl_players(position)")
      .eq("team_id", teamId)
      .is("dropped_at", null),
  ]);

  if (!slots) return { error: "Could not read the roster settings." };

  const lockedByPlayer = new Map(
    (locked ?? []).map((l) => [l.player_id as string, l.slot_key as string]),
  );

  const positionOf = new Map(
    (roster ?? []).map((r) => {
      const player = r.nfl_players as unknown as { position: string | null } | null;
      return [r.player_id as string, player?.position ?? null];
    }),
  );

  // A locked player keeps the slot he locked into, whatever was sent.
  for (const [playerId, slotKey] of lockedByPlayer) {
    assignments.set(playerId, slotKey);
  }

  // Validate before writing anything, so a bad lineup is rejected whole.
  const counts = new Map<string, number>();
  for (const [playerId, slotKey] of assignments) {
    if (!slotKey) continue;
    const slot = slots.find((s) => s.slot_key === slotKey);
    if (!slot) return { error: `Unknown roster slot "${slotKey}".` };

    if (!positionOf.has(playerId)) {
      return { error: "That player is not on your roster." };
    }

    const eligible = slot.eligible_positions as string[];
    const position = positionOf.get(playerId) ?? null;
    if (eligible.length > 0 && (!position || !eligible.includes(position))) {
      return { error: `A ${position ?? "?"} cannot start at ${slotKey}.` };
    }

    counts.set(slotKey, (counts.get(slotKey) ?? 0) + 1);
  }

  for (const slot of slots) {
    const used = counts.get(slot.slot_key) ?? 0;
    if (used > slot.count) {
      return {
        error: `Too many players at ${slot.slot_key}: ${used} of ${slot.count}.`,
      };
    }
  }

  // Rewrite the unlocked half of the lineup.
  const { error: delError } = await supabase
    .from("lineup_entries")
    .delete()
    .eq("team_id", teamId)
    .eq("season", season)
    .eq("week", week)
    .is("locked_at", null);

  if (delError) return { error: delError.message };

  const rows = [...assignments]
    .filter(([playerId, slotKey]) => slotKey && !lockedByPlayer.has(playerId))
    .map(([playerId, slotKey]) => ({
      league_id: leagueId,
      team_id: teamId,
      season,
      week,
      player_id: playerId,
      slot_key: slotKey,
    }));

  if (rows.length > 0) {
    const { error } = await supabase.from("lineup_entries").insert(rows);
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
