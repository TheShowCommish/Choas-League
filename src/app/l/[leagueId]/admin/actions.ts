"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
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

    // Two field shapes: points__<stat> is the rule for everyone,
    // pos__<stat>__<POSITION> overrides it for one position.
    const changes: {
      league_id: string;
      stat_key: string;
      points: number;
      positions: string[];
    }[] = [];
    const removals: { stat_key: string; position: string }[] = [];

    for (const [key, value] of formData.entries()) {
      const raw = String(value).trim();

      if (key.startsWith("points__")) {
        const statKey = key.slice("points__".length);
        const points = Number(raw);
        if (!Number.isFinite(points)) {
          return { error: `"${raw}" is not a number (${statKey}).` };
        }
        changes.push({
          league_id: leagueId,
          stat_key: statKey,
          points,
          positions: [],
        });
        continue;
      }

    }

    // The positional rules arrive as one JSON field holding the whole
    // set, so a rule the commissioner deleted is identifiable by its
    // absence -- a field-per-rule form cannot express a removal.
    const overridesRaw = formData.get("position_overrides");
    if (overridesRaw !== null) {
      let parsed: { statKey: string; position: string; points: string }[];
      try {
        parsed = JSON.parse(String(overridesRaw));
      } catch {
        return { error: "The positional rules could not be read." };
      }

      const kept = new Set<string>();
      for (const row of parsed) {
        if (!row.statKey || !row.position) continue;

        const points = Number(row.points);
        if (!Number.isFinite(points)) {
          return {
            error: `"${row.points}" is not a number (${row.statKey}/${row.position}).`,
          };
        }

        kept.add(`${row.statKey}__${row.position}`);
        changes.push({
          league_id: leagueId,
          stat_key: row.statKey,
          points,
          positions: [row.position],
        });
      }

      // Whatever the league had that is no longer in the list.
      const { data: existing } = await supabase
        .from("league_scoring_rules")
        .select("stat_key, positions")
        .eq("league_id", leagueId);

      for (const rule of existing ?? []) {
        const positions = (rule.positions ?? []) as string[];
        if (positions.length === 0) continue;
        for (const position of positions) {
          if (!kept.has(`${rule.stat_key}__${position}`)) {
            removals.push({ stat_key: rule.stat_key as string, position });
          }
        }
      }
    }

    if (changes.length === 0 && removals.length === 0) {
      return { ok: "Nothing to save." };
    }

    for (const removal of removals) {
      const { error } = await supabase
        .from("league_scoring_rules")
        .delete()
        .eq("league_id", leagueId)
        .eq("stat_key", removal.stat_key)
        .eq("positions", `{${removal.position}}`);
      if (error) return { error: error.message };
    }

    const { error } = changes.length
      ? await supabase
          .from("league_scoring_rules")
          .upsert(changes, { onConflict: "league_id,stat_key,positions" })
      : { error: null };

    if (error) return { error: error.message };

    // A scoring rule is retroactive by nature, so apply it straight away
    // rather than leaving the league on stale numbers until somebody
    // remembers to press recompute.
    const { error: rescoreError } = await supabase.rpc(
      "recompute_season_scores",
      { p_league: leagueId },
    );

    revalidatePath(`/l/${leagueId}`, "layout");
    return {
      ok:
        `Saved ${changes.length + removals.length} scoring change${changes.length + removals.length === 1 ? "" : "s"}.` +
        (rescoreError
          ? ` Scores could not be updated automatically (${rescoreError.message}) -- use "Recompute all weeks".`
          : " Every week has been rescored."),
    };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Per-position roster caps. A blank box means no limit at that position. */
export async function savePositionLimits(
  _prev: AdminResult,
  formData: FormData,
): Promise<AdminResult> {
  const leagueId = String(formData.get("league_id"));

  try {
    const supabase = await assertCommissioner(leagueId);

    const keep: { league_id: string; position: string; max_count: number }[] = [];
    const clear: string[] = [];

    for (const [key, value] of formData.entries()) {
      if (!key.startsWith("limit__")) continue;
      const position = key.slice("limit__".length);
      const raw = String(value).trim();

      if (raw === "") {
        clear.push(position);
        continue;
      }

      const max = Number(raw);
      if (!Number.isInteger(max) || max < 0) {
        return { error: `"${raw}" is not a whole number (${position}).` };
      }
      keep.push({ league_id: leagueId, position, max_count: max });
    }

    if (clear.length > 0) {
      const { error } = await supabase
        .from("league_position_limits")
        .delete()
        .eq("league_id", leagueId)
        .in("position", clear);
      if (error) return { error: error.message };
    }

    if (keep.length > 0) {
      const { error } = await supabase
        .from("league_position_limits")
        .upsert(keep, { onConflict: "league_id,position" });
      if (error) return { error: error.message };
    }

    revalidatePath(`/l/${leagueId}`, "layout");
    return { ok: "Position limits saved." };
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

  // "All weeks" means every week we hold stats for, which is not the
  // same as 1..current_week: a league created in January sits at week 1
  // with a whole season behind it.
  if (week === null) {
    const { data: weeksScored, error } = await supabase.rpc(
      "recompute_season_scores",
      { p_league: leagueId },
    );
    if (error) return { error: error.message };

    revalidatePath(`/l/${leagueId}`, "layout");
    return {
      ok:
        weeksScored === 0
          ? "No stats for this season yet, so there was nothing to score."
          : `Rescored ${weeksScored} week${weeksScored === 1 ? "" : "s"}.`,
    };
  }

  const { error } = await supabase.rpc("recompute_week_scores", {
    p_league: leagueId,
    p_season: league.season,
    p_week: week,
  });
  if (error) return { error: `Week ${week}: ${error.message}` };

  revalidatePath(`/l/${leagueId}`, "layout");
  return { ok: `Week ${week} rescored.` };
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

/** Replace the playoff round configuration in one go. */
export async function savePlayoffRounds(
  leagueId: string,
  rounds: {
    bracket: "winners" | "losers";
    round_index: number;
    name: string;
    weeks: number;
    teams: number | null;
    byes: number;
  }[],
): Promise<AdminResult> {
  try {
    const supabase = await assertCommissioner(leagueId);

    // Replace rather than upsert: a round the commissioner removed has
    // to disappear, and an upsert cannot express that.
    const { error: clearError } = await supabase
      .from("league_playoff_rounds")
      .delete()
      .eq("league_id", leagueId);
    if (clearError) return { error: clearError.message };

    if (rounds.length > 0) {
      const { error } = await supabase.from("league_playoff_rounds").insert(
        rounds.map((r) => ({
          league_id: leagueId,
          bracket: r.bracket,
          round_index: r.round_index,
          name: r.name.trim(),
          weeks: r.weeks,
          // Null field size means "however many are still standing",
          // which is what the bracket did before it could be told.
          teams: r.teams && r.teams >= 2 ? r.teams : null,
          byes: Math.max(0, r.byes),
        })),
      );
      if (error) return { error: error.message };
    }

    revalidatePath(`/l/${leagueId}`, "layout");
    return {
      ok:
        rounds.length === 0
          ? "Playoff rounds cleared; the bracket will be worked out automatically."
          : `Saved ${rounds.length} playoff round${rounds.length === 1 ? "" : "s"}.`,
    };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Fix the draft order by hand. Rebuilds the board, so it is destructive. */
export async function setDraftOrder(
  leagueId: string,
  teamIds: string[],
): Promise<AdminResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_draft_order", {
    p_league: leagueId,
    p_team_ids: teamIds,
  });

  if (error) return { error: error.message };

  revalidatePath(`/l/${leagueId}/admin`);
  revalidatePath(`/l/${leagueId}/draft`);
  return { ok: "Draft order saved. The board has been rebuilt." };
}

/** Grow or shrink the league. Only ever removes teams nobody manages. */
export async function setTeamCount(
  leagueId: string,
  count: number,
): Promise<AdminResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_team_count", {
    p_league: leagueId,
    p_count: count,
  });

  if (error) return { error: error.message };

  revalidatePath(`/l/${leagueId}`, "layout");
  return { ok: `The league now has ${count} teams.` };
}

/** Hand a team to a member, or take it back. */
export async function setupDraft(
  leagueId: string,
  formData: FormData,
): Promise<AdminResult> {
  const supabase = await createClient();

  // The draft row has to exist and carry its settings before the picks
  // are generated, since the board is built from rounds and order.
  const { data: existing } = await supabase
    .from("drafts")
    .select("id, seconds_per_pick, auction_budget")
    .eq("league_id", leagueId)
    .maybeSingle();

  const type = String(formData.get("type") ?? "snake");
  const rounds = num(formData, "rounds", 16);
  // The form only renders the fields belonging to the chosen format, so
  // an absent field means "leave it alone", not "reset it to default".
  const secondsPerPick = num(
    formData,
    "seconds_per_pick",
    existing?.seconds_per_pick ?? 90,
  );
  const auctionBudget = num(
    formData,
    "auction_budget",
    existing?.auction_budget ?? 200,
  );
  const randomize = formData.get("randomize") === "on";

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

/**
 * Deletes a league, and with it everything that hangs off one.
 *
 * Every table that references a league does so `on delete cascade`, so
 * this one statement takes the teams, rosters, lineups, matchups, draft,
 * trades, chat and the whole scoring history with it. There is no undo
 * and no soft-delete flag to unset afterwards, which is why the caller
 * has to type the league's name back: a confirm() dialog is one stray
 * Enter away from ending somebody's season.
 *
 * Only the commissioner can do it -- the RLS policy on leagues restricts
 * delete to commissioner_id, so a member who forged the request gets
 * zero rows affected rather than a deletion.
 */
export async function deleteLeague(
  leagueId: string,
  typedName: string,
): Promise<AdminResult> {
  try {
    const supabase = await assertCommissioner(leagueId);

    const { data: league } = await supabase
      .from("leagues")
      .select("name")
      .eq("id", leagueId)
      .maybeSingle();

    if (!league) return { error: "That league no longer exists." };

    if (typedName.trim() !== league.name) {
      return {
        error: `Type the league's name exactly -- "${league.name}" -- to delete it.`,
      };
    }

    const { error } = await supabase
      .from("leagues")
      .delete()
      .eq("id", leagueId);

    if (error) return { error: error.message };
  } catch (err) {
    return { error: (err as Error).message };
  }

  // Outside the try: redirect works by throwing, and catching it here
  // would turn a successful deletion into an error message.
  revalidatePath("/leagues");
  redirect("/leagues");
}
