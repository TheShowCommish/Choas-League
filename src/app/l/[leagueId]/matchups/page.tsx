import { getLeagueContext } from "@/lib/league";
import { fetchMatchupsCoveringWeek } from "@/lib/matchup-weeks";
import { createClient } from "@/lib/supabase/server";
import type { Matchup, PlayoffSeed } from "@/lib/types";
import { WeekTabs } from "../week-picker";
import { PlayoffBracket } from "./bracket";
import { MatchupCard } from "./matchup-card";

export default async function MatchupsPage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string }>;
  searchParams: Promise<{ week?: string }>;
}) {
  const { leagueId } = await params;
  const { week: weekParam } = await searchParams;
  const { league, teams, myTeam } = await getLeagueContext(leagueId);

  const week = Number(weekParam) || league.current_week;
  const lastWeek = Math.max(league.regular_season_weeks + 4, week);

  // Past the last regular season week the page stops being a list of
  // fixtures and becomes a draw, so it needs every playoff game rather
  // than one week of them.
  const inPlayoffs = week >= league.playoff_start_week;

  const supabase = await createClient();
  const [matchups, { data: seedRows }] = await Promise.all([
    inPlayoffs
      ? supabase
          .from("matchups")
          .select("*")
          .eq("league_id", leagueId)
          .eq("season", league.season)
          .eq("is_playoff", true)
          .order("week")
          .then(({ data }) => (data ?? []) as Matchup[])
      : fetchMatchupsCoveringWeek(supabase, {
          leagueId,
          season: league.season,
          week,
        }),
    inPlayoffs
      ? supabase
          .from("playoff_seeds")
          .select("*")
          .eq("league_id", leagueId)
          .eq("season", league.season)
      : Promise.resolve({ data: [] }),
  ]);

  const teamById = new Map(teams.map((t) => [t.id, t]));
  // A team knocked out of the playoffs is seeded in both brackets.
  const seedsIn = (bracket: PlayoffSeed["bracket"]) =>
    new Map(
      ((seedRows ?? []) as PlayoffSeed[])
        .filter((s) => (s.bracket ?? "winners") === bracket)
        .map((s) => [s.team_id, s.seed]),
    );
  const seeds = { winners: seedsIn("winners"), losers: seedsIn("losers") };

  return (
    <div className="space-y-4">
      <header className="space-y-3">
        <h1 className="h1">{inPlayoffs ? "Playoffs" : "Matchups"}</h1>
        <WeekTabs
          week={week}
          lastWeek={lastWeek}
          currentWeek={league.current_week}
          playoffStartWeek={league.playoff_start_week}
        />
      </header>

      {matchups.length === 0 ? (
        <p className="card muted">
          {inPlayoffs
            ? `No playoff bracket yet. The commissioner generates it from the admin page once the regular season is done.`
            : `No matchups scheduled for week ${week}. The commissioner generates the schedule from the admin page.`}
        </p>
      ) : inPlayoffs ? (
        <PlayoffBracket
          leagueId={leagueId}
          matchups={matchups}
          teamById={teamById}
          myTeamId={myTeam?.id ?? null}
          seeds={seeds}
          losersMode={league.losers_mode}
          losersEnabled={league.losers_bracket_enabled}
          losersStartWeek={league.losers_start_week}
          selectedWeek={week}
        />
      ) : (
        <ul className="space-y-3">
          {matchups.map((m) => {
            // A matchup can outlive its team if the commissioner removes
            // one, so neither side is guaranteed to resolve.
            const home = teamById.get(m.home_team_id) ?? null;
            if (!home) return null;

            return (
              <li key={m.id}>
                <MatchupCard
                  leagueId={leagueId}
                  matchup={m}
                  home={home}
                  away={
                    m.away_team_id
                      ? (teamById.get(m.away_team_id) ?? null)
                      : null
                  }
                  mine={
                    m.home_team_id === myTeam?.id ||
                    m.away_team_id === myTeam?.id
                  }
                  week={week}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
