import { runJob } from "@/lib/ingest/cron-auth";
import { syncSeasonProjections } from "@/lib/ingest/sync";
import { currentSeason } from "@/lib/ingest/nflverse";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Pulls this season's projections from Sleeper.
 *
 * Worth running daily through the summer, when the draft board is what
 * people are looking at, and weekly once the season is under way -- a
 * season projection moves with injuries and depth charts, just slowly.
 */
export async function GET(request: Request) {
  return runJob(request, async () => {
    const url = new URL(request.url);
    const season = Number(url.searchParams.get("season")) || currentSeason();
    return syncSeasonProjections(season);
  });
}
