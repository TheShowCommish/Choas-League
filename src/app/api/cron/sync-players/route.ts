import { runJob } from "@/lib/ingest/cron-auth";
import { syncPlayers } from "@/lib/ingest/sync";
import { currentSeason } from "@/lib/ingest/nflverse";

// Streaming a 25k-row CSV and upserting it takes a while.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Refreshes the player table. Daily is plenty outside of cut season. */
export async function GET(request: Request) {
  return runJob(request, async () => {
    const url = new URL(request.url);
    const season = Number(url.searchParams.get("season")) || currentSeason();
    return syncPlayers(season);
  });
}
