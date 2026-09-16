import Link from "next/link";
import { notFound } from "next/navigation";
import { safeColor, tint } from "@/lib/colors";
import { getLeagueContext } from "@/lib/league";
import {
  matchupWeekIndex,
  matchupWeekOfLabel,
  matchupWeeks,
  matchupWinner,
  parseMatchupView,
} from "@/lib/matchup-weeks";
import { getTeamRoster, type RosterEntry } from "@/lib/roster";
import { createClient } from "@/lib/supabase/server";
import { expandSlots, positionLabel } from "@/lib/roster-slots";
import type { Matchup, RosterSlot, Team } from "@/lib/types";
import { NflCrest } from "../../nfl-crest";
import { TeamCrest } from "../../team-theme";
import { WeeksBadge } from "../weeks-badge";

/** Both sides' rosters for one week of the matchup. */
interface WeekRosters {
  week: number;
  home: RosterEntry[];
  away: RosterEntry[];
}

/** Each side's starter points in one week of the matchup. */
interface WeekPoints {
  week: number;
  home: number;
  away: number;
}

/**
 * A matchup, week by week.
 *
 * A multi-week matchup is scored as the sum of its weeks, so `?week=`
 * picks one week inside the span to look at and anything else shows the
 * total -- every covered week's lineups, one after the other. A
 * single-week matchup only has the total, which is the one week.
 */
export default async function MatchupPage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string; matchupId: string }>;
  searchParams: Promise<{ week?: string | string[] }>;
}) {
  const { leagueId, matchupId } = await params;
  const { week: weekParam } = await searchParams;
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

  const view = parseMatchupView(matchup, weekParam);
  const multiWeek = matchup.week_count > 1;
  const coveredWeeks = matchupWeeks(matchup);
  const shownWeeks = view === "total" ? coveredWeeks : [view];

  const [weekly, fetchedPoints] = await Promise.all([
    Promise.all(
      shownWeeks.map(async (week): Promise<WeekRosters> => {
        const [homeRoster, awayRoster] = await Promise.all([
          getTeamRoster(leagueId, home.id, league.season, week),
          away
            ? getTeamRoster(leagueId, away.id, league.season, week)
            : Promise.resolve([]),
        ]);
        return { week, home: homeRoster, away: awayRoster };
      }),
    ),
    // Each week's starter points, from the same function the matchup
    // score is summed with, so the weeks add up to the total. Only
    // needed when there is more than one week to split.
    multiWeek
      ? Promise.all(
          coveredWeeks.map(async (week): Promise<WeekPoints | null> => {
            const { data: rows, error } = await supabase.rpc(
              "team_points_over",
              {
                p_league: leagueId,
                p_season: league.season,
                p_from: week,
                p_to: week,
              },
            );
            // A failed call is not a scoreless week; drop it so the
            // page falls back to the totals rather than showing 0.0.
            if (error) return null;
            const byTeam = new Map(
              ((rows ?? []) as { team_id: string; points: number }[]).map(
                (r) => [r.team_id, Number(r.points)],
              ),
            );
            return {
              week,
              home: byTeam.get(home.id) ?? 0,
              away: away ? (byTeam.get(away.id) ?? 0) : 0,
            };
          }),
        )
      : Promise.resolve([]),
  ]);

  // Per-week points are all or nothing: one week missing would make the
  // weeks stop adding up to the total, so any failure drops the split.
  const weekPoints = fetchedPoints.every((p): p is WeekPoints => p !== null)
    ? fetchedPoints
    : [];
  const hasWeekPoints = multiWeek && weekPoints.length === coveredWeeks.length;

  // One row per individual starting spot: a 2-RB league gets two RB rows.
  const starterSpots = expandSlots(rosterSlots).filter((s) => s.isStarter);

  const isFinal = matchup.status === "final";
  // Neither side wins a tie.
  const winnerSide = matchupWinner(matchup);
  const homeWon = winnerSide === "home";
  const awayWon = winnerSide === "away";

  // One week picked: the header shows that week's points, and nobody
  // has won a single week of a matchup, so no side is marked the winner.
  const picked =
    view === "total" || !hasWeekPoints
      ? null
      : (weekPoints.find((p) => p.week === view) ?? null);
  const homeScore = picked ? picked.home : Number(matchup.home_score);
  const awayScore = picked ? picked.away : Number(matchup.away_score);

  const backWeek = view === "total" ? matchup.week : view;
  const matchupHref = `/l/${leagueId}/matchups/${matchup.id}`;

  // A single-week matchup keeps its "WK 15". A multi-week one says
  // which view the header's scores belong to; the badge under it carries
  // the span, or the picked week's place in it.
  const statusLabel = isFinal
    ? "FINAL"
    : !multiWeek
      ? `WK ${matchup.week}`
      : !picked
        ? "TOTAL"
        : `WK ${view}`;

  return (
    <div className="space-y-4">
      <Link
        href={`/l/${leagueId}/matchups?week=${backWeek}`}
        className="muted text-sm"
      >
        &larr; Week {backWeek}
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
            score={awayScore}
            winner={!picked && isFinal && awayWon && away !== null}
            align="left"
          />

          <div
            className={`flex shrink-0 flex-col items-center justify-center px-2 py-3 ${
              multiWeek ? "gap-1" : ""
            }`}
          >
            <span className="muted text-xs font-semibold tracking-wide">
              {statusLabel}
            </span>
            <WeeksBadge
              matchup={matchup}
              week={view === "total" ? undefined : view}
              compact
            />
            {matchup.is_playoff && matchup.playoff_round && (
              <span className="muted text-xs">{matchup.playoff_round}</span>
            )}
          </div>

          <ScoreHalf
            team={home}
            score={homeScore}
            winner={!picked && isFinal && homeWon}
            align="right"
          />
        </div>
      </header>

      {/*
        Sticky just under the scoreboard, so the week can be changed from
        anywhere down a long stack of lineups. Links rather than state:
        every view has its own URL to drop in the league chat. The site
        header does not stick, so top-0 is clear of it.
      */}
      {multiWeek && (
        <nav
          aria-label="Matchup week"
          className="sticky top-0 z-10 -mx-4 bg-background px-4 py-2"
        >
          <div className="segmented">
            <Link
              href={matchupHref}
              aria-current={view === "total" ? "page" : undefined}
              className="segmented-item"
            >
              Total
            </Link>
            {coveredWeeks.map((week) => {
              const index = matchupWeekIndex(matchup, week);
              return (
                <Link
                  key={week}
                  href={`${matchupHref}?week=${week}`}
                  aria-current={view === week ? "page" : undefined}
                  aria-label={`Week ${index} of ${coveredWeeks.length}, NFL week ${week}`}
                  className="segmented-item gap-1.5"
                >
                  <span>Week {index}</span>
                  <span className="hidden text-xs font-normal opacity-75 sm:inline">
                    Wk {week}
                  </span>
                </Link>
              );
            })}
          </div>
        </nav>
      )}

      {hasWeekPoints && view === "total" && (
        <BoxScore
          matchupHref={matchupHref}
          matchup={matchup}
          home={home}
          away={away}
          weekPoints={weekPoints}
          isFinal={isFinal}
        />
      )}

      {weekly.map((rosters) => {
        const stacked = multiWeek && view === "total";
        const points = weekPoints.find((p) => p.week === rosters.week);

        return (
          <section key={rosters.week} className="space-y-4">
            {/* Only the total of a multi-week matchup stacks several weeks. */}
            {stacked && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-4">
                <h2 className="h2">
                  {matchupWeekOfLabel(matchup, rosters.week)}
                  <span className="sr-only">, NFL week {rosters.week}</span>
                </h2>
                <span aria-hidden className="muted text-xs">
                  NFL week {rosters.week}
                </span>
                {points && away && (
                  <span className="text-sm font-semibold tabular-nums">
                    {points.away.toFixed(1)}
                    <span className="muted mx-1 font-normal">&ndash;</span>
                    {points.home.toFixed(1)}
                  </span>
                )}
                <Link
                  href={`${matchupHref}?week=${rosters.week}`}
                  className="ml-auto inline-flex min-h-11 items-center rounded-md px-1 text-sm text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent md:min-h-9"
                >
                  Only this week &rarr;
                </Link>
              </div>
            )}

            <WeekLineups
              leagueId={leagueId}
              home={home}
              away={away}
              rosters={rosters}
              starterSpots={starterSpots}
              rosterSlots={rosterSlots}
            />
          </section>
        );
      })}
    </div>
  );
}

/**
 * Points by week, read like a line score: a row per team, a column per
 * week, the total last. Each week's higher score is in full ink and the
 * lower one muted, so who took which week reads without comparing
 * digits; once final, the winner gets a bold total and a marker. Crest
 * and abbreviation on a phone keep up to four week columns and the total
 * inside 375px; the full name comes back when there is room.
 */
function BoxScore({
  matchupHref,
  matchup,
  home,
  away,
  weekPoints,
  isFinal,
}: {
  matchupHref: string;
  matchup: Matchup;
  home: Team;
  away: Team | null;
  weekPoints: { week: number; home: number; away: number }[];
  isFinal: boolean;
}) {
  const homeTotal = Number(matchup.home_score);
  const awayTotal = Number(matchup.away_score);

  const rows = [
    ...(away
      ? [
          {
            team: away,
            side: "away" as const,
            total: awayTotal,
            won: isFinal && awayTotal > homeTotal,
          },
        ]
      : []),
    {
      team: home,
      side: "home" as const,
      total: homeTotal,
      won: isFinal && away !== null && homeTotal > awayTotal,
    },
  ];

  return (
    <div className="card-tight overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="px-3 pt-3 pb-1 text-left text-xs font-semibold tracking-wide text-muted uppercase">
            Points by week
          </caption>
          <thead>
            <tr className="border-b border-border text-xs text-muted">
              <th scope="col" className="px-3 py-2 text-left font-medium">
                <span className="sr-only">Team</span>
              </th>
              {weekPoints.map((p) => {
                const index = matchupWeekIndex(matchup, p.week);
                return (
                  <th
                    key={p.week}
                    scope="col"
                    className="px-1 py-1.5 text-right font-medium whitespace-nowrap"
                  >
                    <Link
                      href={`${matchupHref}?week=${p.week}`}
                      className="inline-block rounded px-1 py-0.5 hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      <span className="block tracking-wide uppercase">
                        <span className="sm:hidden">W{index}</span>
                        <span className="hidden sm:inline">Week {index}</span>
                      </span>
                      <span className="block text-[11px] font-normal opacity-80">
                        <span className="sr-only">NFL week </span>
                        <span aria-hidden>Wk </span>
                        {p.week}
                      </span>
                    </Link>
                  </th>
                );
              })}
              <th
                scope="col"
                className="bg-surface-2 px-2 py-2 text-right font-semibold sm:px-3 tracking-wide text-foreground uppercase"
              >
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.team.id}
                className="border-b border-border/60 last:border-b-0"
              >
                <th
                  scope="row"
                  className="px-2 py-2 text-left font-normal sm:px-3"
                  style={{
                    boxShadow: `inset 3px 0 0 ${safeColor(row.team.color)}`,
                  }}
                >
                  <span className="flex items-center gap-2">
                    <TeamCrest
                      logoUrl={row.team.logo_url}
                      abbreviation={row.team.abbreviation}
                      name={row.team.name}
                      color={row.team.color}
                      secondary={row.team.secondary_color}
                      size={22}
                    />
                    <span
                      className={`whitespace-nowrap ${row.won ? "font-semibold" : ""}`}
                    >
                      <span aria-hidden className="sm:hidden">
                        {row.team.abbreviation}
                      </span>
                      <span className="sr-only sm:not-sr-only sm:inline-block sm:max-w-56 sm:truncate sm:align-bottom">
                        {row.team.name}
                      </span>
                    </span>
                  </span>
                </th>
                {weekPoints.map((p) => {
                  const mine = p[row.side];
                  const theirs = row.side === "home" ? p.away : p.home;
                  const behind = away !== null && mine < theirs;
                  return (
                    <td
                      key={p.week}
                      className={`px-1.5 py-2 text-right whitespace-nowrap tabular-nums sm:px-2 ${
                        behind ? "text-muted" : "font-medium"
                      }`}
                    >
                      {mine.toFixed(1)}
                    </td>
                  );
                })}
                <td
                  className={`bg-surface-2 px-2 py-2 text-right whitespace-nowrap tabular-nums sm:px-3 ${
                    row.won ? "font-bold" : "font-semibold"
                  }`}
                >
                  {row.total.toFixed(1)}
                  {row.won && <span className="sr-only"> (winner)</span>}
                  {isFinal && away && (
                    // Both totals carry the slot, so their digits line up.
                    <span
                      aria-hidden
                      className={`ml-1.5 inline-block size-0 border-y-4 border-r-[6px] border-y-transparent border-r-accent align-middle ${row.won ? "" : "invisible"}`}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The starters side by side, then each bench, for one week. */
function WeekLineups({
  leagueId,
  home,
  away,
  rosters,
  starterSpots,
  rosterSlots,
}: {
  leagueId: string;
  home: Team;
  away: Team | null;
  rosters: WeekRosters;
  starterSpots: ReturnType<typeof expandSlots>;
  rosterSlots: RosterSlot[];
}) {
  const homeBySlot = groupBySlot(rosters.home);
  const awayBySlot = groupBySlot(rosters.away);

  const homeBench = benchOf(rosters.home, rosterSlots);
  const awayBench = benchOf(rosters.away, rosterSlots);

  return (
    <>
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
    </>
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
