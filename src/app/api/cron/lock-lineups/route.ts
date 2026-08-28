import { runJob } from "@/lib/ingest/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { currentSeason } from "@/lib/ingest/nflverse";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

/**
 * Stamps locked_at on lineup entries whose NFL game has kicked off.
 *
 * Locking is a stored fact rather than a comparison done at read time:
 * once a row is locked it stays locked even if the schedule is later
 * corrected, and the lineup editor can trust the flag without needing
 * every kickoff time to hand.
 */
export async function GET(request: Request) {
  return runJob(request, async () => {
    const supabase = createAdminClient();
    const season = currentSeason();
    const now = new Date().toISOString();

    const { data: games, error } = await supabase
      .from("nfl_games")
      .select("week, home_team, away_team")
      .eq("season", season)
      .lte("kickoff_at", now);

    if (error) throw new Error(error.message);

    const startedByWeek = new Map<number, string[]>();
    for (const game of games ?? []) {
      const week = game.week as number;
      const list = startedByWeek.get(week) ?? [];
      if (game.home_team) list.push(game.home_team as string);
      if (game.away_team) list.push(game.away_team as string);
      startedByWeek.set(week, list);
    }

    let locked = 0;

    for (const [week, teams] of startedByWeek) {
      if (teams.length === 0) continue;

      const { data: players } = await supabase
        .from("nfl_players")
        .select("id")
        .in("team_abbr", teams);

      const ids = (players ?? []).map((p) => p.id as string);
      // Team defenses are pseudo-players, so they are not in that result.
      ids.push(...teams.map((t) => `DST_${t}`));

      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const { data, error: lockError } = await supabase
          .from("lineup_entries")
          .update({ locked_at: now })
          .eq("season", season)
          .eq("week", week)
          .is("locked_at", null)
          .in("player_id", chunk)
          .select("id");

        if (lockError) throw new Error(lockError.message);
        locked += data?.length ?? 0;
      }
    }

    return { locked };
  });
}
