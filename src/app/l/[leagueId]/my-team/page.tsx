import Link from "next/link";
import { getLeagueContext } from "@/lib/league";
import { fetchMatchupsCoveringWeek } from "@/lib/matchup-weeks";
import { createClient } from "@/lib/supabase/server";
import { getTeamRoster } from "@/lib/roster";
import { byPosition, positionLabel } from "@/lib/roster-slots";
import type { Matchup, StandingsRow, Team } from "@/lib/types";
import { LineupEditor } from "./editor";
import { TeamSettings } from "./team-settings";
import { WeeksBadge } from "../matchups/weeks-badge";
import { TeamCrest, TeamTheme } from "../team-theme";
import { WeekPicker } from "../week-picker";

export default async function MyTeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string }>;
  searchParams: Promise<{ week?: string }>;
}) {
  const { leagueId } = await params;
  const { week: weekParam } = await searchParams;
  const { league, teams, myTeam, rosterSlots } =
    await getLeagueContext(leagueId);

  if (!myTeam) {
    return (
      <div className="card">
        <h1 className="h1 mb-2">No team yet</h1>
        <p className="muted mb-3">
          You are in this league but have not taken a team. Pick one off the
          board -- you can rename it and set its colours afterwards.
        </p>
        <Link href={`/l/${leagueId}/claim`} className="btn btn-primary">
          Choose a team
        </Link>
      </div>
    );
  }

  const week = Number(weekParam) || league.current_week;
  const roster = await getTeamRoster(leagueId, myTeam.id, league.season, week);

  const supabase = await createClient();

  // Position limits count the whole roster, bench and IR included, so
  // the summary has to be about the roster rather than the lineup.
  const [{ data: limitRows }, matchupRows, { data: standingsRows }] =
    await Promise.all([
      supabase
        .from("league_position_limits")
        .select("position, max_count")
        .eq("league_id", leagueId),
      fetchMatchupsCoveringWeek(supabase, {
        leagueId,
        season: league.season,
        week,
        teamId: myTeam.id,
      }),
      supabase.from("standings").select("*").eq("league_id", leagueId),
    ]);

  const heldByPosition = new Map<string, number>();
  for (const entry of roster) {
    const position = entry.player.position;
    if (!position) continue;
    heldByPosition.set(position, (heldByPosition.get(position) ?? 0) + 1);
  }

  // In the order a lineup card reads -- QB, RB, WR, TE, K, DEF -- rather
  // than alphabetically, which put the defence first and the quarterback
  // third.
  const limits = (limitRows ?? [])
    .map((row) => ({
      position: row.position as string,
      max: row.max_count as number,
      held: heldByPosition.get(row.position as string) ?? 0,
    }))
    .sort((a, b) => byPosition(a.position, b.position));

  const capacity = rosterSlots.reduce((sum, slot) => sum + slot.count, 0);

  // Regular season plus the playoff rounds, so lineups can be set ahead.
  const lastWeek = Math.max(league.regular_season_weeks + 4, week);

  const matchup = matchupRows[0] ?? null;
  const standings = (standingsRows ?? []) as StandingsRow[];

  return (
    <TeamTheme
      color={myTeam.color}
      secondary={myTeam.secondary_color}
      className="space-y-5"
    >
      <header className="card-tight overflow-hidden">
        <div
          className="h-1.5 w-full"
          style={{
            background: `linear-gradient(90deg, var(--team), var(--team-2))`,
          }}
        />

        <div className="flex flex-wrap items-center gap-4 p-4">
          <TeamCrest
            logoUrl={myTeam.logo_url}
            abbreviation={myTeam.abbreviation}
            name={myTeam.name}
            color={myTeam.color}
            secondary={myTeam.secondary_color}
            size={64}
          />

          <div className="min-w-0 flex-1">
            {myTeam.city && <p className="muted text-sm">{myTeam.city}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="h1">{myTeam.name}</h1>
              <TeamSettings
                leagueId={leagueId}
                teamId={myTeam.id}
                team={{
                  name: myTeam.name,
                  city: myTeam.city,
                  abbreviation: myTeam.abbreviation,
                  color: myTeam.color,
                  secondaryColor: myTeam.secondary_color,
                  logoUrl: myTeam.logo_url,
                }}
              />
            </div>
            <p className="muted">
              ${myTeam.faab_remaining} FAAB left &middot; waiver priority{" "}
              {myTeam.waiver_priority} &middot; {roster.length}/{capacity}{" "}
              players
            </p>
          </div>

          <WeekPicker
            week={week}
            lastWeek={lastWeek}
            currentWeek={league.current_week}
          />
        </div>
      </header>

      <MatchupPreview
        leagueId={leagueId}
        week={week}
        myTeam={myTeam}
        matchup={matchup}
        teams={teams}
        standings={standings}
      />

      {limits.length > 0 && (
        <div className="card flex flex-wrap gap-2">
          {limits.map(({ position, max, held }) => (
            <span
              key={position}
              className={`pill ${
                held > max
                  ? "border-negative text-negative"
                  : held === max
                    ? "border-positive text-positive"
                    : ""
              }`}
              title={`${held} of a maximum ${max} at ${position}`}
            >
              {positionLabel(position)} {held}/{max}
            </span>
          ))}
        </div>
      )}

      {roster.length === 0 ? (
        <div className="card">
          <p className="muted mb-3">
            Your roster is empty. Add players from the free agent pool, or wait
            for the draft.
          </p>
          <Link href={`/l/${leagueId}/players`} className="btn btn-primary">
            Find players
          </Link>
        </div>
      ) : (
        <LineupEditor
          leagueId={leagueId}
          teamId={myTeam.id}
          season={league.season}
          week={week}
          slots={rosterSlots}
          roster={roster}
        />
      )}
    </TeamTheme>
  );
}

/**
 * Who you are playing this week, before you set the lineup rather than
 * after.
 *
 * The lineup page is where the decisions are made, and every one of
 * them is a decision against somebody: a safe floor is right against a
 * strong opponent and wrong against a weak one. Sending people to the
 * matchups tab to find out who that is made the two halves of the same
 * question live on different pages.
 */
function MatchupPreview({
  leagueId,
  week,
  myTeam,
  matchup,
  teams,
  standings,
}: {
  leagueId: string;
  week: number;
  myTeam: Team;
  matchup: Matchup | null;
  teams: Team[];
  standings: StandingsRow[];
}) {
  if (!matchup) {
    return (
      <p className="card muted text-sm">
        No opponent scheduled for week {week} yet.
      </p>
    );
  }

  const isHome = matchup.home_team_id === myTeam.id;
  const opponentId = isHome ? matchup.away_team_id : matchup.home_team_id;
  const opponent = opponentId ? teams.find((t) => t.id === opponentId) : null;

  if (!opponent) {
    return (
      <div className="card">
        <p className="text-sm font-medium">Week {week}: bye</p>
        <p className="muted text-sm">
          Nobody to play. Your starters still score, and the points count.
        </p>
      </div>
    );
  }

  const myScore = Number(isHome ? matchup.home_score : matchup.away_score);
  const theirScore = Number(isHome ? matchup.away_score : matchup.home_score);
  const played = matchup.status !== "scheduled";

  const record = (teamId: string) => {
    const row = standings.find((s) => s.team_id === teamId);
    if (!row) return null;
    return row.ties > 0
      ? `${row.wins}-${row.losses}-${row.ties}`
      : `${row.wins}-${row.losses}`;
  };

  const myRecord = record(myTeam.id);
  const theirRecord = record(opponent.id);

  return (
    <Link
      href={`/l/${leagueId}/matchups/${matchup.id}`}
      className="card block hover:border-accent"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="muted text-xs uppercase tracking-wide">
          Week {week} &middot; {isHome ? "home" : "away"}
        </span>
        <WeeksBadge matchup={matchup} week={week} compact />
        <span className="muted ml-auto text-xs">
          {matchup.status === "final"
            ? "Final"
            : matchup.status === "in_progress"
              ? "In progress"
              : "Not started"}
        </span>
      </div>

      <div className="mt-2 flex items-center gap-3">
        <TeamCrest
          logoUrl={myTeam.logo_url}
          abbreviation={myTeam.abbreviation}
          name={myTeam.name}
          color={myTeam.color}
          secondary={myTeam.secondary_color}
          size={36}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            {myTeam.name}
          </span>
          {myRecord && <span className="muted text-xs">{myRecord}</span>}
        </span>

        {played && (
          <span className="text-lg font-semibold tabular-nums">
            {myScore.toFixed(1)}
          </span>
        )}

        <span className="muted px-1 text-xs">vs</span>

        {played && (
          <span className="text-lg font-semibold tabular-nums">
            {theirScore.toFixed(1)}
          </span>
        )}

        <span className="min-w-0 flex-1 text-right">
          <span className="block truncate text-sm font-medium">
            {opponent.name}
          </span>
          {theirRecord && <span className="muted text-xs">{theirRecord}</span>}
        </span>
        <TeamCrest
          logoUrl={opponent.logo_url}
          abbreviation={opponent.abbreviation}
          name={opponent.name}
          color={opponent.color}
          secondary={opponent.secondary_color}
          size={36}
        />
      </div>
    </Link>
  );
}
