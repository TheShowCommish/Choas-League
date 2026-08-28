import { runJob } from "@/lib/ingest/cron-auth";
import { syncWeekStats } from "@/lib/ingest/sync";
import { currentSeason } from "@/lib/ingest/nflverse";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Pulls the official stat lines and rescores every league.
 *
 * With no ?week it does the week the leagues are currently on, which is
 * what the scheduled run wants. ?week=all backfills the whole season --
 * use that once after setting a league up mid-season.
 */
export async function GET(request: Request) {
  return runJob(request, async () => {
    const url = new URL(request.url);
    const season = Number(url.searchParams.get("season")) || currentSeason();
    const weekParam = url.searchParams.get("week");

    if (weekParam === "all") return syncWeekStats(season, null);
    if (weekParam) return syncWeekStats(season, Number(weekParam));

    // Default to the furthest-along week any league is on, so a league
    // that has not advanced yet still gets its previous week corrected.
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("leagues")
      .select("current_week")
      .eq("season", season)
      .order("current_week", { ascending: false })
      .limit(1)
      .maybeSingle();

    return syncWeekStats(season, data?.current_week ?? 1);
  });
}
