import { runJob } from "@/lib/ingest/cron-auth";
import { syncAdp } from "@/lib/ingest/sync";
import { currentSeason } from "@/lib/ingest/nflverse";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

/**
 * Refreshes average draft position from ESPN.
 *
 * Worth running daily through August, when ADP moves every time somebody
 * gets hurt in camp, and not at all once the drafts are done.
 */
export async function GET(request: Request) {
  return runJob(request, async () => {
    const url = new URL(request.url);
    const season = Number(url.searchParams.get("season")) || currentSeason();
    return syncAdp(season);
  });
}
