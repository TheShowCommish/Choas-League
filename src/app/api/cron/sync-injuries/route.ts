import { runJob } from "@/lib/ingest/cron-auth";
import { syncInjuries } from "@/lib/ingest/sync";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

/**
 * Refreshes every player's injury designation.
 *
 * The cheapest useful job here and the one worth running most often:
 * a Friday practice report is the difference between starting somebody
 * and benching them, and it lands hours before kickoff.
 */
export async function GET(request: Request) {
  return runJob(request, async () => syncInjuries());
}
