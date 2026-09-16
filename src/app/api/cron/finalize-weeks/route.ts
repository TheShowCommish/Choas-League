import { runJob } from "@/lib/ingest/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

/**
 * Closes every matchup whose last week is over, in every league.
 *
 * "Over" is decided in the database (nfl_week_is_complete): every NFL
 * game that week final or postponed, every final game carrying official
 * (nflverse) stat lines, and the last kickoff 36 hours gone so the
 * overnight corrections have landed. A two-week playoff matchup
 * waits for its second week. Safe to run as often as you like: a final
 * matchup is never touched again, so a repeat run closes nothing.
 */
export async function GET(request: Request) {
  return runJob(request, async () => {
    const supabase = createAdminClient();

    const { data, error } = await supabase.rpc("finalize_completed_weeks");
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as {
      league_id: string;
      season: number;
      week: number;
      closed: number;
    }[];

    return {
      closed: rows.reduce((sum, r) => sum + r.closed, 0),
      weeks: rows,
    };
  });
}
