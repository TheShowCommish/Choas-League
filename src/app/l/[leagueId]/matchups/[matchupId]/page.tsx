import Link from "next/link";
import { notFound } from "next/navigation";
import { safeColor, tint } from "@/lib/colors";
import {
  headToHead,
  type HeadToHeadMatchup,
  type HeadToHeadSummary,
} from "@/lib/head-to-head";
import { getLeagueContext } from "@/lib/league";
import {
  matchupWeekIndex,
  matchupWeekOfLabel,
  matchupWeeks,
  matchupWinner,
  parseMatchupView,
} from "@/lib/matchup-weeks";
import {
  projectMatchup,
  type MatchupProjection,
  type SideProjection,
  type StarterProjectionInput,
} from "@/lib/matchup-projection";
import { getTeamRoster, type RosterEntry } from "@/lib/roster";
import { createClient } from "@/lib/supabase/server";
import { expandSlots, positionLabel } from "@/lib/roster-slots";
import type { Matchup, RosterSlot, Team } from "@/lib/types";
import { NflCrest } from "../../nfl-crest";
import { TeamCrest } from "../../team-theme";
import { WeeksBadge } from "../weeks-badge";
import { PlayerBreakdown } from "./player-breakdown";

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

  const [weekly, fetchedPoints, h2hResult] = await Promise.all([
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
    // This season's finalized meetings between the two teams, for the
    // head-to-head series line (T-082). Scoped to league.season so a future
    // season cannot double-count (BOARD T-052); both home/away orientations.
    // A bye has no opponent, so there is nothing to tally. The current
    // matchup is included once it is final, so a decided series counts itself.
    away
      ? supabase
          .from("matchups")
          .select("home_team_id,away_team_id,home_score,away_score,status")
          .eq("league_id", leagueId)
          .eq("season", league.season)
          .eq("status", "final")
          .or(
            `and(home_team_id.eq.${home.id},away_team_id.eq.${away.id}),` +
              `and(home_team_id.eq.${away.id},away_team_id.eq.${home.id})`,
          )
      : Promise.resolve({ data: [] }),
  ]);

  // Per-week points are all or nothing: one week missing would make the
  // weeks stop adding up to the total, so any failure drops the split.
  const weekPoints = fetchedPoints.every((p): p is WeekPoints => p !== null)
    ? fetchedPoints
    : [];
  const hasWeekPoints = multiWeek && weekPoints.length === coveredWeeks.length;

  // One row per individual starting spot: a 2-RB league gets two RB rows.
  const starterSpots = expandSlots(rosterSlots).filter((s) => s.isStarter);

  // A live projection of where the shown weeks are heading. Each starter
  // whose game is final counts his real points; everyone else counts his
  // weekly projection, scored in this league's rules (team_projections,
  // 0028). Projections are fetched per team-week and keyed by player; a
  // bye, a missing projection, or a failed call simply counts as zero, so
  // a projected final still reconciles to the real final once every game
  // is final (every starter is then on his actual points).
  const starterSlotKeys = new Set(
    rosterSlots.filter((s) => s.is_starter).map((s) => s.slot_key),
  );
  const projTeams = [home, away].filter((t): t is Team => t !== null);

  const projByTeamWeek = new Map<string, Map<string, number>>();
  await Promise.all(
    shownWeeks.flatMap((week) =>
      projTeams.map(async (team) => {
        const { data: rows, error } = await supabase.rpc("team_projections", {
          p_league: leagueId,
          p_team: team.id,
          p_season: league.season,
          p_week: week,
        });
        if (error) return;
        projByTeamWeek.set(
          `${team.id}:${week}`,
          new Map(
            ((rows ?? []) as { player_id: string; points: number }[]).map(
              (r) => [r.player_id, Number(r.points)],
            ),
          ),
        );
      }),
    ),
  );

  // Starters across every shown week, flattened into one list per side:
  // projectMatchup's numbers are additive sums over starters, so a
  // multi-week total is just all its weeks' starters together.
  const homeStarters: StarterProjectionInput[] = [];
  const awayStarters: StarterProjectionInput[] = [];
  for (const rosters of weekly) {
    const homeProj = projByTeamWeek.get(`${home.id}:${rosters.week}`);
    for (const entry of startersOf(rosters.home, starterSlotKeys)) {
      homeStarters.push(starterInput(entry, homeProj));
    }
    if (away) {
      const awayProj = projByTeamWeek.get(`${away.id}:${rosters.week}`);
      for (const entry of startersOf(rosters.away, starterSlotKeys)) {
        awayStarters.push(starterInput(entry, awayProj));
      }
    }
  }
  const projection = projectMatchup(
    homeStarters,
    away ? awayStarters : null,
  );

  const isFinal = matchup.status === "final";
  // Neither side wins a tie.
  const winnerSide = matchupWinner(matchup);
  const homeWon = winnerSide === "home";
  const awayWon = winnerSide === "away";

  // The all-time (this-season) series between the two teams, from the home
  // team's side. Null for a bye -- there is no opponent to have a record with.
  const series = away
    ? headToHead(
        home.id,
        away.id,
        ((h2hResult.data ?? []) as Matchup[]).map(
          (m): HeadToHeadMatchup => ({
            homeTeamId: m.home_team_id,
            awayTeamId: m.away_team_id,
            homeScore: Number(m.home_score),
            awayScore: Number(m.away_score),
            status: m.status,
          }),
        ),
      )
    : null;

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
            dim={!picked && isFinal && homeWon}
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
            dim={!picked && isFinal && awayWon && away !== null}
            align="right"
          />
        </div>
      </header>

      {/*
        The head-to-head series line (T-082): a quiet one-liner under the
        scoreboard saying who leads the all-time (this-season) series. Minimal
        markup on purpose -- a designer owns how this finally reads; this is
        the value and where it lives. Omitted on a bye (no opponent).
      */}
      {series && away && (
        <p data-h2h className="muted text-sm" aria-label="Head-to-head series">
          {seriesLabel(series, home, away)}
        </p>
      )}

      {/*
        A plain live-projection strip (T-071). Projected final per side, how
        many starters are still to play and the points they are projected to
        add, and the projected margin. Only shown while the matchup is live --
        once final the projection equals the real score. Minimal markup on
        purpose: a designer owns how this finally reads; these are the values.
      */}
      {!isFinal && (
        <ProjectionStrip projection={projection} home={home} away={away} />
      )}

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
 * The head-to-head series line (T-082), from the home team's side:
 * "First meeting this season" before they have met, "Series tied 1-1" when
 * level, otherwise "Series: NAME leads 2-1". Drawn games, if any, trail as
 * "(1 tie)". Season-scoped for now (see head-to-head.ts); a future
 * multi-season view would widen the source and this copy. Minimal copy on
 * purpose -- a designer owns how this reads.
 */
function seriesLabel(
  series: HeadToHeadSummary,
  home: Team,
  away: Team,
): string {
  if (series.leader === "none") return "First meeting this season";

  const ties =
    series.ties > 0
      ? ` (${series.ties} tie${series.ties > 1 ? "s" : ""})`
      : "";

  if (series.leader === "tied") {
    return `Series tied ${series.teamAWins}-${series.teamBWins}${ties}`;
  }

  const [name, lead, trail] =
    series.leader === "a"
      ? [home.name, series.teamAWins, series.teamBWins]
      : [away.name, series.teamBWins, series.teamAWins];
  return `Series: ${name} leads ${lead}-${trail}${ties}`;
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
            lost: isFinal && homeTotal > awayTotal,
          },
        ]
      : []),
    {
      team: home,
      side: "home" as const,
      total: homeTotal,
      won: isFinal && away !== null && homeTotal > awayTotal,
      lost: isFinal && away !== null && awayTotal > homeTotal,
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
                      className={`score px-1.5 py-2 text-right text-base whitespace-nowrap sm:px-2 sm:text-lg ${
                        behind ? "font-semibold text-muted" : "text-foreground"
                      }`}
                    >
                      {mine.toFixed(1)}
                    </td>
                  );
                })}
                <td
                  className={`score bg-surface-2 px-2 py-2 text-right text-lg whitespace-nowrap sm:px-3 sm:text-xl ${
                    row.lost ? "text-muted" : "text-foreground"
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
  dim = false,
  align,
}: {
  team: Team | null;
  score: number;
  winner: boolean;
  /** This side lost a decided game: its score is dimmed so the winner leads. */
  dim?: boolean;
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
      {/* The scoreboard number: condensed, confident, the loudest thing on
          the page. The loser's is dimmed so the winner reads at a glance. */}
      <p
        className={`score mt-1 text-4xl leading-none md:text-5xl ${
          dim ? "text-muted" : "text-foreground"
        }`}
      >
        {score.toFixed(1)}
      </p>
    </div>
  );
}

/** This week's starters: roster entries sitting in a starting slot. */
function startersOf(
  roster: RosterEntry[],
  starterSlotKeys: Set<string>,
): RosterEntry[] {
  return roster.filter(
    (entry) => entry.slotKey !== null && starterSlotKeys.has(entry.slotKey),
  );
}

/**
 * One starter reduced to what projectMatchup needs: his actual points, his
 * projection (0 when absent), and his game's status (null on a bye).
 */
function starterInput(
  entry: RosterEntry,
  projByPlayer: Map<string, number> | undefined,
): StarterProjectionInput {
  return {
    actual: entry.points,
    projected: projByPlayer?.get(entry.playerId) ?? 0,
    status: entry.game?.status ?? null,
  };
}

/**
 * The live projection, under the live scoreboard (T-071).
 *
 * Reads as the quieter echo of the big score above it: a "PROJECTED" label
 * so the smaller numbers are never mistaken for the live ones, each side's
 * projected final with what it still has to come, an accent chip saying who
 * is projected to win by how much, and a two-colour bar splitting the
 * projected points between the sides -- away on the left, home on the right,
 * so it lines up with the scoreboard halves. Hidden once the matchup is final.
 */
function ProjectionStrip({
  projection,
  home,
  away,
}: {
  projection: MatchupProjection;
  home: Team;
  away: Team | null;
}) {
  const { margin } = projection;

  // A bye week has no opponent: show just this side's projected final, with
  // no who-wins chip or split bar to draw.
  if (!away) {
    return (
      <section className="card-tight px-3 py-2.5" aria-label="Projected final">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
            Projected
          </span>
          <div className="text-right">
            <span className="score block text-2xl leading-none text-foreground">
              {projection.home.projFinal.toFixed(1)}
            </span>
            <span className="muted mt-0.5 block text-xs leading-snug">
              {toPlayLabel(projection.home)}
            </span>
          </div>
        </div>
      </section>
    );
  }

  const leader = margin > 0 ? home : margin < 0 ? away : null;
  const lead = Math.abs(margin);

  // Each side's share of the projected points, for the split bar. Before any
  // projections land the total is 0; split it evenly rather than divide by 0.
  const total = projection.home.projFinal + projection.away.projFinal;
  const homeShare = total > 0 ? (projection.home.projFinal / total) * 100 : 50;
  const awayShare = 100 - homeShare;

  return (
    <section className="card-tight overflow-hidden" aria-label="Projected final">
      {/* Label on the left, the verdict on the right: who is projected to win,
          in the accent colour so it reads as a call rather than an alarm. */}
      <div className="flex items-center justify-between gap-2 px-3 pt-2.5">
        <span className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
          Projected
        </span>
        {leader ? (
          <span className="inline-flex items-center rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-xs font-semibold tabular-nums text-accent">
            {leader.abbreviation} by {lead.toFixed(1)}
          </span>
        ) : (
          <span className="muted text-xs font-medium">Dead even</span>
        )}
      </div>

      {/* Projected finals, lined up under the live score above: away left,
          home right. Smaller than the scoreboard so they stay the echo. */}
      <div className="flex items-end justify-between gap-3 px-3 pt-1 pb-2.5">
        <ProjectionSide team={away} side={projection.away} align="left" />
        <ProjectionSide team={home} side={projection.home} align="right" />
      </div>

      {/* The projected points, split between the sides in their own colours.
          A footer strip, not a win-probability -- it is the two projected
          finals drawn to scale. */}
      <div
        className="flex h-1.5 w-full overflow-hidden"
        role="img"
        aria-label={`Projected points: ${away.abbreviation} ${projection.away.projFinal.toFixed(1)}, ${home.abbreviation} ${projection.home.projFinal.toFixed(1)}`}
      >
        <div style={{ width: `${awayShare}%`, background: safeColor(away.color) }} />
        <div style={{ width: `${homeShare}%`, background: safeColor(home.color) }} />
      </div>
    </section>
  );
}

/** One side of the projection strip: projected final, then what is left. */
function ProjectionSide({
  team,
  side,
  align,
}: {
  team: Team | null;
  side: SideProjection;
  align: "left" | "right";
}) {
  if (!team) return <div className="min-w-0 flex-1" aria-hidden />;

  const right = align === "right";

  return (
    <div className={`min-w-0 flex-1 ${right ? "text-right" : ""}`}>
      <span className="score block text-2xl leading-none text-foreground">
        {side.projFinal.toFixed(1)}
      </span>
      <span className="muted mt-0.5 block text-xs leading-snug">
        {toPlayLabel(side)}
      </span>
    </div>
  );
}

/**
 * What a side still has coming, from the same numbers. "Yet to play" counts
 * only starters who have not kicked off; "to come" is every unfinished
 * starter's projection, so a side with games in progress but none left to
 * start reads "in play" rather than the wrong "all played".
 */
function toPlayLabel(side: SideProjection): string {
  if (side.yetToPlay > 0) {
    return `${side.yetToPlay} to play · ${side.remaining.toFixed(1)} to come`;
  }
  if (side.remaining > 0) {
    return `in play · ${side.remaining.toFixed(1)} to come`;
  }
  return "all played";
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
  // When both spots are filled, the one who outscored the other keeps full
  // ink and the other dims -- the two numbers flanking the slot read as the
  // little head-to-head they are.
  const bothHere = home !== undefined && away !== undefined;
  const awayDim = bothHere && away!.points < home!.points;
  const homeDim = bothHere && home!.points < away!.points;

  return (
    <div className="flex items-center gap-1 px-2 py-2 text-sm">
      <PlayerCell entry={away} leagueId={leagueId} align="left" dim={awayDim} />
      <span className="w-12 shrink-0 text-center text-[11px] font-semibold tracking-wide text-muted uppercase">
        {label}
      </span>
      <PlayerCell entry={home} leagueId={leagueId} align="right" dim={homeDim} />
    </div>
  );
}

function PlayerCell({
  entry,
  leagueId,
  align,
  dim = false,
}: {
  entry?: RosterEntry;
  leagueId: string;
  align: "left" | "right";
  dim?: boolean;
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
    <PlayerBreakdown leagueId={leagueId} entry={entry} className="min-w-0 flex-1">
      {/* The points sit on the inside edge, next to the slot label, so the
          two sides' numbers face off; the name and meta trail to the
          outside. The number is the dominant mark in the row. */}
      <span
        className={`flex items-center gap-1.5 sm:gap-2 ${right ? "flex-row-reverse" : ""}`}
      >
        <span
          className={`score w-11 shrink-0 text-xl leading-none sm:w-14 sm:text-2xl ${
            right ? "text-left" : "text-right"
          } ${dim ? "text-muted" : "text-foreground"}`}
        >
          {entry.points.toFixed(1)}
        </span>
        <span className={`min-w-0 flex-1 ${right ? "text-right" : ""}`}>
          <span
            className={`flex items-center gap-1.5 ${right ? "flex-row-reverse" : ""}`}
          >
            <span className="hidden shrink-0 sm:inline-flex">
              <NflCrest abbr={entry.player.team_abbr} size={18} />
            </span>
            <span className="min-w-0 flex-1 truncate">
              {entry.player.full_name}
            </span>
          </span>
          <span className="muted block text-xs">
            {positionLabel(entry.player.position)} &middot;{" "}
            {entry.game ? entry.opponent : "BYE"}
          </span>
        </span>
      </span>
    </PlayerBreakdown>
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
        <span className="score shrink-0 text-lg">{total.toFixed(1)}</span>
      </summary>

      <ul className="divide-y divide-border/60 border-t border-border">
        {entries.map((entry) => (
          <li key={entry.playerId}>
            <PlayerBreakdown
              leagueId={leagueId}
              entry={entry}
              className="block"
            >
              <span className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="flex min-w-0 items-center gap-1.5">
                  <NflCrest abbr={entry.player.team_abbr} size={18} />
                  <span className="min-w-0 truncate">
                    {entry.player.full_name}
                    <span className="muted ml-2 text-xs">
                      {positionLabel(entry.player.position)}
                    </span>
                  </span>
                </span>
                <span className="score shrink-0 text-base text-foreground">
                  {entry.points.toFixed(1)}
                </span>
              </span>
            </PlayerBreakdown>
          </li>
        ))}
      </ul>
    </details>
  );
}
