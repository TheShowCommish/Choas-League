import { runJob } from "@/lib/ingest/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  waiverLostNotification,
  waiverWonNotification,
} from "@/lib/notifications";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Runs waivers for every league whose configured process time has come
 * round in its own timezone.
 *
 * The cron fires hourly; each league is only processed in the hour that
 * matches its waiver_process_dow and waiver_process_time, so leagues in
 * different timezones with different schedules all work off one job.
 */
export async function GET(request: Request) {
  return runJob(request, async () => {
    const supabase = createAdminClient();

    const { data: leagues, error } = await supabase
      .from("leagues")
      .select("id, name, timezone, waiver_process_dow, waiver_process_time")
      .in("status", ["in_season", "playoffs"]);

    if (error) throw new Error(error.message);

    const now = new Date();
    const processed: string[] = [];
    let skipped = 0;

    for (const league of leagues ?? []) {
      const local = localParts(now, league.timezone as string);
      const [hour] = (league.waiver_process_time as string).split(":");

      if (
        local.weekday !== league.waiver_process_dow ||
        local.hour !== Number(hour)
      ) {
        skipped++;
        continue;
      }

      // A small look-back covers any clock skew between here and the
      // database; the hourly cadence means it never reaches a prior run.
      const since = new Date(Date.now() - 60_000).toISOString();

      const { error: runError } = await supabase.rpc("process_waivers", {
        p_league: league.id,
      });
      if (runError) throw new Error(`${league.name}: ${runError.message}`);
      processed.push(league.name as string);

      await notifyWaiverResults(supabase, league.id as string, since);
    }

    return { processed, skipped };
  });
}

/**
 * Tell each manager how their claims landed. Winners always; losers only
 * when they actually lost a contest (status 'lost' -- outbid or beaten to
 * the player), not when a claim was invalid (no FAAB, roster full). Best
 * -effort: a failed alert must not fail the waiver run.
 */
async function notifyWaiverResults(
  supabase: AdminClient,
  leagueId: string,
  since: string,
) {
  try {
    const { data: claims } = await supabase
      .from("waiver_claims")
      .select("add_player_id, bid_amount, status, result_note, team_id")
      .eq("league_id", leagueId)
      .gte("processed_at", since)
      .in("status", ["won", "lost"]);

    if (!claims || claims.length === 0) return;

    const teamIds = [...new Set(claims.map((c) => c.team_id as string))];
    const playerIds = [...new Set(claims.map((c) => c.add_player_id as string))];

    const [{ data: teams }, { data: players }] = await Promise.all([
      supabase.from("teams").select("id, owner_id").in("id", teamIds),
      supabase.from("nfl_players").select("id, full_name").in("id", playerIds),
    ]);

    const ownerOf = new Map(
      (teams ?? []).map((t) => [t.id as string, t.owner_id as string | null]),
    );
    const nameOf = new Map(
      (players ?? []).map((p) => [p.id as string, p.full_name as string]),
    );

    for (const c of claims) {
      const owner = ownerOf.get(c.team_id as string);
      if (!owner) continue;
      const playerName = nameOf.get(c.add_player_id as string) ?? "a player";

      const draft =
        c.status === "won"
          ? waiverWonNotification(
              leagueId,
              playerName,
              c.bid_amount as number | null,
            )
          : waiverLostNotification(
              leagueId,
              playerName,
              (c.result_note as string) ?? "",
            );

      await supabase.rpc("notify", {
        p_league: leagueId,
        p_recipient: owner,
        p_type: draft.type,
        p_title: draft.title,
        p_body: draft.body,
        p_link: draft.link,
        p_data: { playerId: c.add_player_id },
      });
    }
  } catch {
    // best-effort
  }
}

/** Day of week (0 = Sunday) and hour, in a given IANA timezone. */
function localParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((p) => [p.type, p.value]),
  );

  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    weekday: days.indexOf(parts.weekday ?? "Sun"),
    hour: Number(parts.hour),
  };
}
