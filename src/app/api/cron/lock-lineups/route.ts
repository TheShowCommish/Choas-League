import { runJob } from "@/lib/ingest/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

/**
 * Stamps locked_at on lineup entries whose lock time has passed, and
 * puts unrostered players whose game has started on waivers in leagues
 * that want that (apply_kickoff_locks, migration 0042).
 *
 * The stamp is a record, not the guard. The lineup_entries trigger
 * enforces the lock from kickoff times whether or not this has run, and
 * this uses the same rule -- each league's own lineup_lock_mode -- so the
 * two cannot disagree. Once stamped, a row stays locked even if the
 * schedule is later corrected.
 */
export async function GET(request: Request) {
  return runJob(request, async () => {
    const supabase = createAdminClient();

    const { data, error } = await supabase.rpc("apply_kickoff_locks");
    if (error) throw new Error(error.message);

    const row = (Array.isArray(data) ? data[0] : data) as
      | { locked: number; held: number }
      | null;

    return { locked: row?.locked ?? 0, held: row?.held ?? 0 };
  });
}
