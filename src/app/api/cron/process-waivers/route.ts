import { runJob } from "@/lib/ingest/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

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

      const { error: runError } = await supabase.rpc("process_waivers", {
        p_league: league.id,
      });
      if (runError) throw new Error(`${league.name}: ${runError.message}`);
      processed.push(league.name as string);
    }

    return { processed, skipped };
  });
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
