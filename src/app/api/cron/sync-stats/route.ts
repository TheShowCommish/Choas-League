import { runJob } from "@/lib/ingest/cron-auth";
import { syncWeekStats } from "@/lib/ingest/sync";
import { currentSeason } from "@/lib/ingest/nflverse";
import { statWeeksToSync } from "@/lib/ingest/stat-weeks";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Pulls the official stat lines and rescores every league.
 *
 * With no ?week it does the latest NFL week that has kicked off and the
 * week before it (see statWeeksToSync), which is what the scheduled run
 * wants. ?week=N does one week; ?week=all backfills the whole season --
 * use that once after setting a league up mid-season.
 */
export async function GET(request: Request) {
  return runJob(request, async () => {
    const url = new URL(request.url);
    const season = Number(url.searchParams.get("season")) || currentSeason();
    const weekParam = url.searchParams.get("week");

    if (weekParam === "all") return syncWeekStats(season, null);
    if (weekParam) return syncWeekStats(season, Number(weekParam));

    const supabase = createAdminClient();
    const { data: games, error } = await supabase
      .from("nfl_games")
      .select("week, kickoff_at")
      .eq("season", season)
      .neq("season_type", "PRE");
    if (error) throw new Error(error.message);

    const weeks = statWeeksToSync(
      (games ?? []) as { week: number; kickoff_at: string | null }[],
      new Date(),
    );
    if (weeks.length === 0) {
      return {
        job: "sync_stats",
        rows: 0,
        message: "No games have kicked off this season yet.",
      };
    }

    // One at a time: each streams the season's stat files.
    const results = [];
    for (const week of weeks) {
      results.push(await syncWeekStats(season, week));
    }
    return results;
  });
}
