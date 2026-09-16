import Link from "next/link";
import { notFound } from "next/navigation";
import { safeColor, tint } from "@/lib/colors";
import { getLeagueContext } from "@/lib/league";
import { getTeamRoster, type RosterEntry } from "@/lib/roster";
import { createClient } from "@/lib/supabase/server";
import { expandSlots, positionLabel } from "@/lib/roster-slots";
import type { Matchup, Team } from "@/lib/types";
import { NflCrest } from "../../nfl-crest";
import { TeamCrest } from "../../team-theme";

export default async function MatchupPage({
  params,
}: {
  params: Promise<{ leagueId: string; matchupId: string }>;
}) {
  const { leagueId, matchupId } = await params;
  const { league, teams, rosterSlots } = await getLeagueContext(leagueId);
  const supabase = await createClient();

  const { data } = await supabase
    .from("matchups")
    .select("*")
    .eq("id", matchupId)
    .maybeSingle();

  if (!data) notFound();
  const matchup = data as Matchup;

  const home = teams.find((t) => t.id === matchup.home_team_id);
  const away = matchup.away_team_id
    ? (teams.find((t) => t.id === matchup.away_team_id) ?? null)
    : null;

  if (!home) notFound();

  const [homeRoster, awayRoster] = await Promise.all([
    getTeamRoster(leagueId, home.id, league.season, matchup.week),
    away
      ? getTeamRoster(leagueId, away.id, league.season, matchup.week)
      : Promise.resolve([]),
  ]);

  // One row per individual starting spot: a 2-RB league gets two RB rows.
  const starterSpots = expandSlots(rosterSlots).filter((s) => s.isStarter);

  const homeBySlot = groupBySlot(homeRoster);
  const awayBySlot = groupBySlot(awayRoster);

  const homeBench = benchOf(homeRoster, rosterSlots);
  const awayBench = benchOf(awayRoster, rosterSlots);

  const isFinal = matchup.status === "final";
  const homeWon = Number(matchup.home_score) > Number(matchup.away_score);

  return (
    <div className="space-y-4">
      <Link
        href={`/l/${leagueId}/matchups?week=${matchup.week}`}
        className="muted text-sm"
      >
        &larr; Week {matchup.week}
      </Link>

      {/*
        Each manager gets their own half of the scoreboard, in their own
        colours, washing out towards the middle. Which half is which is
        then obvious from across the room, which is what a team having
        colours is for.
      */}
      <header className="card-tight overflow-hidden">
        <div className="flex items-stretch">
          <ScoreHalf
            team={away}
            score={Number(matchup.away_score)}
            winner={isFinal && !homeWon && away !== null}
            align="left"
          />

          <div className="flex shrink-0 flex-col items-center justify-center px-2 py-3">
            <span className="muted text-xs font-semibold tracking-wide">
              {isFinal ? "FINAL" : `WK ${matchup.week}`}
            </span>
            {matchup.week_count > 1 && (
              <span className="muted text-xs">{matchup.week_count} weeks</span>
            )}
            {matchup.is_playoff && matchup.playoff_round && (
              <span className="muted text-xs">{matchup.playoff_round}</span>
            )}
          </div>

          <ScoreHalf
            team={home}
            score={Number(matchup.home_score)}
            winner={isFinal && homeWon}
            align="right"
          />
        </div>
      </header>

      {!away ? (
        <p className="card muted">{home.name} has a bye this week.</p>
      ) : (
        <div className="card-tight divide-y divide-border">
          {starterSpots.map((spot, index) => {
            // Nth spot of this slot type on each side.
            const nth = starterSpots
              .slice(0, index)
              .filter((s) => s.slotKey === spot.slotKey).length;

            return (
              <MatchupRow
                key={spot.key}
                label={spot.label}
                leagueId={leagueId}
                home={homeBySlot.get(spot.slotKey)?.[nth]}
                away={awayBySlot.get(spot.slotKey)?.[nth]}
              />
            );
          })}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <BenchList
          team={away ?? home}
          leagueId={leagueId}
          entries={away ? awayBench : homeBench}
        />
        <BenchList team={home} leagueId={leagueId} entries={homeBench} />
      </div>
    </div>
  );
}

/**
 * One team's half of the scoreboard.
 *
 * The wash runs outwards from that team's own edge, so the two halves
 * meet in the middle on the page's own background rather than in a
 * collision of two managers' colour choices.
 */
function ScoreHalf({
  team,
  score,
  winner,
  align,
}: {
  team: Team | null;
  score: number;
  winner: boolean;
  align: "left" | "right";
}) {
  const right = align === "right";

  if (!team) {
    return (
      <div className="min-w-0 flex-1 px-3 py-3">
        <p className="muted text-sm">Bye</p>
      </div>
    );
  }

  const color = safeColor(team.color);

  return (
    <div
      className={`min-w-0 flex-1 px-3 py-3 ${right ? "text-right" : ""}`}
      style={{
        background: `linear-gradient(${right ? "270deg" : "90deg"}, ${tint(
          color,
          winner ? 34 : 20,
        )}, transparent 85%)`,
        [right ? "borderRight" : "borderLeft"]: `4px solid ${color}`,
      }}
    >
      <div
        className={`flex items-center gap-2 ${right ? "flex-row-reverse" : ""}`}
      >
        <TeamCrest
          logoUrl={team.logo_url}
          abbreviation={team.abbreviation}
          name={team.name}
          color={team.color}
          secondary={team.secondary_color}
          size={36}
        />
        <p className="min-w-0 flex-1 truncate text-sm">{team.name}</p>
      </div>
      <p
        className={`mt-1 text-2xl tabular-nums ${
          winner ? "font-bold" : "font-semibold"
        }`}
      >
        {score.toFixed(1)}
      </p>
    </div>
  );
}

function groupBySlot(roster: RosterEntry[]) {
  const map = new Map<string, RosterEntry[]>();
  for (const entry of roster) {
    if (!entry.slotKey) continue;
    const list = map.get(entry.slotKey) ?? [];
    list.push(entry);
    map.set(entry.slotKey, list);
  }
  return map;
}

function benchOf(
  roster: RosterEntry[],
  slots: { slot_key: string; is_starter: boolean }[],
) {
  const starterKeys = new Set(
    slots.filter((s) => s.is_starter).map((s) => s.slot_key),
  );
  return roster.filter((r) => !r.slotKey || !starterKeys.has(r.slotKey));
}

function MatchupRow({
  label,
  leagueId,
  home,
  away,
}: {
  label: string;
  leagueId: string;
  home?: RosterEntry;
  away?: RosterEntry;
}) {
  return (
    <div className="flex items-center gap-2 px-2 py-2 text-sm">
      <PlayerCell entry={away} leagueId={leagueId} align="left" />
      <span className="w-14 shrink-0 text-center text-xs text-muted">
        {label}
      </span>
      <PlayerCell entry={home} leagueId={leagueId} align="right" />
    </div>
  );
}

function PlayerCell({
  entry,
  leagueId,
  align,
}: {
  entry?: RosterEntry;
  leagueId: string;
  align: "left" | "right";
}) {
  if (!entry) {
    return (
      <div
        className={`min-w-0 flex-1 text-muted ${align === "right" ? "text-right" : ""}`}
      >
        <span className="text-xs">Empty</span>
      </div>
    );
  }

  const right = align === "right";

  return (
    <div className={`min-w-0 flex-1 ${right ? "text-right" : ""}`}>
      <div
        className={`flex items-center gap-1.5 ${right ? "flex-row-reverse" : ""}`}
      >
        <NflCrest abbr={entry.player.team_abbr} size={18} />
        <Link
          href={`/l/${leagueId}/players/${entry.playerId}`}
          className="min-w-0 flex-1 truncate hover:text-accent"
        >
          {entry.player.full_name}
        </Link>
      </div>
      <span className="muted block text-xs">
        {positionLabel(entry.player.position)} &middot;{" "}
        {entry.game ? entry.opponent : "BYE"} &middot;{" "}
        <span className="tabular-nums">{entry.points.toFixed(1)}</span>
      </span>
    </div>
  );
}

/**
 * The bench, and what it was worth.
 *
 * The total sits in the summary rather than behind it. The bench score
 * is the number managers actually argue about -- it is the whole "I
 * left forty points on the bench" conversation -- and it should not
 * cost a click. The names behind it still do, because the bench is long
 * and the starters above are the game.
 */
function BenchList({
  team,
  leagueId,
  entries,
}: {
  team: Team;
  leagueId: string;
  entries: RosterEntry[];
}) {
  if (entries.length === 0) return null;

  const total = entries.reduce((sum, entry) => sum + entry.points, 0);

  return (
    <details className="card-tight overflow-hidden">
      <summary
        className="flex cursor-pointer items-center gap-2 p-3 text-sm"
        style={{ borderLeft: `4px solid ${safeColor(team.color)}` }}
      >
        <span className="min-w-0 flex-1 truncate font-medium">
          {team.name} bench
        </span>
        <span className="muted shrink-0 text-xs">bench points</span>
        <span className="shrink-0 font-semibold tabular-nums">
          {total.toFixed(1)}
        </span>
      </summary>

      <ul className="divide-y divide-border/60 border-t border-border">
        {entries.map((entry) => (
          <li
            key={entry.playerId}
            className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <NflCrest abbr={entry.player.team_abbr} size={18} />
              <Link
                href={`/l/${leagueId}/players/${entry.playerId}`}
                className="min-w-0 truncate hover:text-accent"
              >
                {entry.player.full_name}
                <span className="muted ml-2 text-xs">
                  {positionLabel(entry.player.position)}
                </span>
              </Link>
            </span>
            <span className="muted tabular-nums">{entry.points.toFixed(1)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
