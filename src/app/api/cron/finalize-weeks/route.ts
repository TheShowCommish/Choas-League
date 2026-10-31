import { runJob } from "@/lib/ingest/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { matchupFinalNotification } from "@/lib/notifications";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

type AdminClient = ReturnType<typeof createAdminClient>;

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

    // One alert per manager per matchup that just finalized. finalize_
    // completed_weeks only returns a league-week in the run that closed
    // it, so these are this run's results. Best-effort.
    for (const r of rows) {
      await notifyFinalMatchups(supabase, r.league_id, r.season, r.week);
    }

    return {
      closed: rows.reduce((sum, r) => sum + r.closed, 0),
      weeks: rows,
    };
  });
}

/**
 * Notify both managers of every matchup that ends in `endWeek` and is now
 * final: "Week N final: W vs OPP", with their own score first. A bye has
 * only the home side. Best-effort -- a failed alert must not fail the job.
 */
async function notifyFinalMatchups(
  supabase: AdminClient,
  leagueId: string,
  season: number,
  endWeek: number,
) {
  try {
    const { data: matchups } = await supabase
      .from("matchups")
      .select(
        "id, week, week_count, home_team_id, away_team_id, home_score, away_score",
      )
      .eq("league_id", leagueId)
      .eq("season", season)
      .eq("status", "final");

    const ending = (matchups ?? []).filter(
      (m) => (m.week as number) + (m.week_count as number) - 1 === endWeek,
    );
    if (ending.length === 0) return;

    const teamIds = [
      ...new Set(
        ending
          .flatMap((m) => [m.home_team_id, m.away_team_id])
          .filter((id): id is string => id != null),
      ),
    ];
    const { data: teams } = await supabase
      .from("teams")
      .select("id, name, owner_id")
      .in("id", teamIds);
    const teamMap = new Map(
      (teams ?? []).map((t) => [
        t.id as string,
        { name: t.name as string, ownerId: t.owner_id as string | null },
      ]),
    );

    const send = async (
      recipient: string,
      myScore: number,
      oppScore: number,
      oppName: string | null,
      matchupId: string,
    ) => {
      const draft = matchupFinalNotification(
        leagueId,
        endWeek,
        myScore,
        oppScore,
        oppName,
      );
      await supabase.rpc("notify", {
        p_league: leagueId,
        p_recipient: recipient,
        p_type: draft.type,
        p_title: draft.title,
        p_body: draft.body,
        p_link: draft.link,
        p_data: { matchupId },
      });
    };

    for (const m of ending) {
      const home = teamMap.get(m.home_team_id as string);
      const away = m.away_team_id
        ? teamMap.get(m.away_team_id as string)
        : null;

      if (home?.ownerId) {
        await send(
          home.ownerId,
          m.home_score as number,
          m.away_score as number,
          away?.name ?? null,
          m.id as string,
        );
      }
      if (away?.ownerId) {
        await send(
          away.ownerId,
          m.away_score as number,
          m.home_score as number,
          home?.name ?? null,
          m.id as string,
        );
      }
    }
  } catch {
    // best-effort
  }
}
