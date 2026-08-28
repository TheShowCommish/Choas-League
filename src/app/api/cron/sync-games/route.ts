import { runJob } from "@/lib/ingest/cron-auth";
import { syncGames } from "@/lib/ingest/sync";
import { currentSeason } from "@/lib/ingest/nflverse";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Refreshes the schedule, final scores and bye weeks. */
export async function GET(request: Request) {
  return runJob(request, async () => {
    const url = new URL(request.url);
    const season = Number(url.searchParams.get("season")) || currentSeason();
    return syncGames(season);
  });
}
