import { runJob } from "@/lib/ingest/cron-auth";
import { syncProjections } from "@/lib/ingest/sync";
import { currentSeason } from "@/lib/ingest/nflverse";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Pulls next week's projections from Sleeper.
 *
 * Worth running through the week rather than once: projections move as
 * injuries are reported, and the Sunday morning number is the one people
 * actually set a lineup against.
 */
export async function GET(request: Request) {
  return runJob(request, async () => {
    const url = new URL(request.url);
    const season = Number(url.searchParams.get("season")) || currentSeason();
    const weekParam = url.searchParams.get("week");

    if (weekParam) return syncProjections(season, Number(weekParam));

    // The week the leagues are actually on: a projection for a week
    // that has already been played is of no use to anyone.
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("leagues")
      .select("current_week")
      .eq("season", season)
      .order("current_week", { ascending: false })
      .limit(1)
      .maybeSingle();

    return syncProjections(season, data?.current_week ?? 1);
  });
}
