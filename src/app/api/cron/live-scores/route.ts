import { runJob } from "@/lib/ingest/cron-auth";
import { syncLiveScores } from "@/lib/ingest/live";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Live in-game scoring from ESPN. Safe to call often -- it does nothing
 * when no game is in progress, and never overwrites a stat line
 * nflverse has already settled.
 */
export async function GET(request: Request) {
  return runJob(request, syncLiveScores);
}
