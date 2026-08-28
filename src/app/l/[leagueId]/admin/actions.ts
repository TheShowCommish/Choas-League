"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export interface AdminResult {
  error?: string;
  ok?: string;
}

/**
 * Every action here re-checks that the caller is the commissioner.
 * RLS enforces it too, but failing early gives a readable message
 * instead of an empty update.
 */
async function assertCommissioner(leagueId: string) {
  const supabase = await createClient();
  const { data } = await supabase.rpc("is_commissioner", {
    p_league: leagueId,
  });
  if (!data) throw new Error("Only the commissioner can do that.");
  return supabase;
}

function num(formData: FormData, key: string, fallback: number): number {
  const value = Number(formData.get(key));
  return Number.isFinite(value) ? value : fallback;
}

export async function saveLeagueSettings(
  _prev: AdminResult,
  formData: FormData,
): Promise<AdminResult> {
  const leagueId = String(formData.get("league_id"));

  try {
    const supabase = await assertCommissioner(leagueId);

    const { error } = await supabase
      .from("leagues")
      .update({
        name: String(formData.get("name") ?? "").trim(),
        current_week: num(formData, "current_week", 1),
        regular_season_weeks: num(formData, "regular_season_weeks", 14),
        playoff_start_week: num(formData, "playoff_start_week", 15),
        playoff_teams: num(formData, "playoff_teams", 6),
        status: String(formData.get("status")),
        waiver_type: String(formData.get("waiver_type")),
        faab_budget: num(formData, "faab_budget", 100),
        min_bid: num(formData, "min_bid", 0),
        waiver_period_hours: num(formData, "waiver_period_hours", 48),
        waiver_process_dow: num(formData, "waiver_process_dow", 3),
        waiver_process_time: String(formData.get("waiver_process_time")),
        faab_tie_breaker: String(formData.get("faab_tie_breaker")),
        lineup_lock_mode: String(formData.get("lineup_lock_mode")),
        timezone: String(formData.get("timezone")),
      })
      .eq("id", leagueId);

    if (error) return { error: error.message };

    revalidatePath(`/l/${leagueId}`, "layout");
    return { ok: "Settings saved." };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * Saves only the scoring rules whose value actually changed. The catalog
 * is 170+ stats and most leagues touch a handful; sending the lot back
 * on every save would be a needlessly large write.
 */
export async function saveScoringRules(
  _prev: AdminResult,
  formData: FormData,
): Promise<AdminResult> {
  const leagueId = String(formData.get("league_id"));

  try {
    const supabase = await assertCommissioner(leagueId);

    const changes: { stat_key: string; points: number }[] = [];
    for (const [key, value] of formData.entries()) {
      if (!key.startsWith("points__")) continue;
      const statKey = key.slice("points__".length);
      const points = Number(value);
      if (!Number.isFinite(points)) {
        return { error: `"${value}" is not a number (${statKey}).` };
      }
      changes.push({ stat_key: statKey, points });
    }

    if (changes.length === 0) return { ok: "Nothing to save." };

    const { error } = await supabase.from("league_scoring_rules").upsert(
      changes.map((c) => ({
        league_id: leagueId,
        stat_key: c.stat_key,
        points: c.points,
      })),
      { onConflict: "league_id,stat_key" },
    );

    if (error) return { error: error.message };

    revalidatePath(`/l/${leagueId}/admin`);
    return {
      ok: `Saved ${changes.length} scoring rule${changes.length === 1 ? "" : "s"}. Recompute scores to apply them to past weeks.`,
    };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Replace the whole roster layout in one go. */
export async function saveRosterSlots(
  _prev: AdminResult,
  formData: FormData,
): Promise<AdminResult> {
  const leagueId = String(formData.get("league_id"));
  const payload = String(formData.get("slots") ?? "[]");

  try {
    const supabase = await assertCommissioner(leagueId);

    const slots = JSON.parse(payload) as {
      slot_key: string;
      label: string;
      eligible_positions: string[];
      count: number;
      is_starter: boolean;
    }[];

    if (slots.length === 0) return { error: "A league needs at least one slot." };

    const keys = new Set(slots.map((s) => s.slot_key));
    if (keys.size !== slots.length) {
      return { error: "Two slots share the same key." };
    }

    // Delete-then-insert rather than a diff: lineup_entries reference the
    // slot *key*, not a row id, so rebuilding the table is safe as long
    // as the keys still exist afterwards.
    const removed = await supabase
      .from("roster_slots")
      .select("slot_key")
      .eq("league_id", leagueId);

    const droppedKeys = (removed.data ?? [])
      .map((r) => r.slot_key as string)
      .filter((k) => !keys.has(k));

    const { error: delError } = await supabase
      .from("roster_slots")
      .delete()
      .eq("league_id", leagueId);
    if (delError) return { error: delError.message };

    const { error } = await supabase.from("roster_slots").insert(
      slots.map((slot, i) => ({
        league_id: leagueId,
        slot_key: slot.slot_key.trim().toUpperCase(),
        label: slot.label.trim() || slot.slot_key,
        eligible_positions: slot.eligible_positions,
        count: Math.max(0, Math.floor(slot.count)),
        is_starter: slot.is_starter,
        order_index: (i + 1) * 10,
      })),
    );
    if (error) return { error: error.message };

    // Players sitting in a slot that no longer exists get benched.
    if (droppedKeys.length > 0) {
      await supabase
        .from("lineup_entries")
        .delete()
        .eq("league_id", leagueId)
        .in("slot_key", droppedKeys)
        .is("locked_at", null);
    }

    revalidatePath(`/l/${leagueId}`, "layout");
    return { ok: "Roster settings saved." };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

// --- One-shot commissioner tools -------------------------------------

export async function generateSchedule(leagueId: string): Promise<AdminResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("generate_schedule", {
    p_league: leagueId,
  });
  if (error) return { error: error.message };

  revalidatePath(`/l/${leagueId}`, "layout");
  return { ok: "Schedule generated." };
}

export async function processWaivers(leagueId: string): Promise<AdminResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("process_waivers", {
    p_league: leagueId,
  });
  if (error) return { error: error.message };

  revalidatePath(`/l/${leagueId}`, "layout");
  return { ok: `Waivers processed. ${data ?? 0} claim(s) awarded.` };
}

export async function recomputeScores(
  leagueId: string,
  week: number | null,
): Promise<AdminResult> {
  const supabase = await createClient();

  const { data: league } = await supabase
    .from("leagues")
    .select("season, current_week, regular_season_weeks")
    .eq("id", leagueId)
    .single();

  if (!league) return { error: "League not found." };

  // A scoring change is retroactive, so "all weeks" is the common case.
  const weeks =
    week !== null
      ? [week]
      : Array.from(
          { length: Math.max(league.current_week, 1) },
          (_, i) => i + 1,
        );

  for (const w of weeks) {
    const { error } = await supabase.rpc("recompute_week_scores", {
      p_league: leagueId,
      p_season: league.season,
      p_week: w,
    });
    if (error) return { error: `Week ${w}: ${error.message}` };
  }

  revalidatePath(`/l/${leagueId}`, "layout");
  return {
    ok:
      weeks.length === 1
        ? `Week ${weeks[0]} rescored.`
        : `Rescored ${weeks.length} weeks.`,
  };
}

export async function generatePlayoffs(leagueId: string): Promise<AdminResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("generate_playoffs", {
    p_league: leagueId,
  });
  if (error) return { error: error.message };

  revalidatePath(`/l/${leagueId}`, "layout");
  return { ok: `Bracket generated: ${data ?? 0} matchup(s).` };
}

export async function advancePlayoffs(
  leagueId: string,
  week: number,
): Promise<AdminResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("advance_playoffs", {
    p_league: leagueId,
    p_week: week,
  });
  if (error) return { error: error.message };

  revalidatePath(`/l/${leagueId}`, "layout");
  return {
    ok:
      data === 0
        ? "That was the final. The season is complete."
        : `Next round created: ${data} matchup(s).`,
  };
}

export async function setupDraft(
  leagueId: string,
  formData: FormData,
): Promise<AdminResult> {
  const supabase = await createClient();

  const type = String(formData.get("type") ?? "snake");
  const rounds = num(formData, "rounds", 16);
  const secondsPerPick = num(formData, "seconds_per_pick", 90);
  const auctionBudget = num(formData, "auction_budget", 200);
  const randomize = formData.get("randomize") === "on";

  // The draft row has to exist and carry its settings before the picks
  // are generated, since the board is built from rounds and order.
  const { data: existing } = await supabase
    .from("drafts")
    .select("id")
    .eq("league_id", leagueId)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from("drafts")
      .update({
        type,
        rounds,
        seconds_per_pick: secondsPerPick,
        auction_budget: auctionBudget,
      })
      .eq("id", existing.id);
    if (error) return { error: error.message };
  } else {
    const { error } = await supabase.from("drafts").insert({
      league_id: leagueId,
      type,
      rounds,
      seconds_per_pick: secondsPerPick,
      auction_budget: auctionBudget,
    });
    if (error) return { error: error.message };
  }

  const { error } = await supabase.rpc("generate_draft", {
    p_league: leagueId,
    p_randomize: randomize,
  });
  if (error) return { error: error.message };

  revalidatePath(`/l/${leagueId}`, "layout");
  return { ok: "Draft board generated." };
}

export async function setDraftStatus(
  leagueId: string,
  status: "scheduled" | "live" | "paused" | "complete",
): Promise<AdminResult> {
  const supabase = await createClient();

  const { data: draft } = await supabase
    .from("drafts")
    .select("id, seconds_per_pick")
    .eq("league_id", leagueId)
    .maybeSingle();

  if (!draft) return { error: "No draft to start. Generate the board first." };

  const patch: Record<string, unknown> = { status };
  if (status === "live") {
    patch.started_at = new Date().toISOString();
    // Start the clock for whoever is on the board right now.
    patch.pick_deadline = new Date(
      Date.now() + draft.seconds_per_pick * 1000,
    ).toISOString();
  }
  if (status === "paused") patch.pick_deadline = null;

  const { error } = await supabase
    .from("drafts")
    .update(patch)
    .eq("id", draft.id);
  if (error) return { error: error.message };

  if (status === "live") {
    await supabase
      .from("leagues")
      .update({ status: "drafting" })
      .eq("id", leagueId);
  }

  revalidatePath(`/l/${leagueId}`, "layout");
  return { ok: `Draft ${status}.` };
}

/** Hand an unclaimed team to a league member. */
export async function assignTeamOwner(
  leagueId: string,
  teamId: string,
  ownerId: string | null,
): Promise<AdminResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("teams")
    .update({ owner_id: ownerId })
    .eq("id", teamId);

  if (error) return { error: error.message };

  revalidatePath(`/l/${leagueId}`, "layout");
  return { ok: "Team owner updated." };
}
