import { matchupCoversWeek, matchupSpanLabel } from "@/lib/matchup-weeks";
import type { Matchup, Team } from "@/lib/types";
import { BracketTabs } from "./bracket-tabs";
import { MatchupCard } from "./matchup-card";
import { WeeksBadge } from "./weeks-badge";

type LosersMode = "consolation" | "toilet_bowl" | null;

/**
 * The playoffs, drawn as a bracket.
 *
 * A week-at-a-time list is the right shape for a round robin and the
 * wrong one for a knockout: what a manager wants to know in December is
 * who they play next and who is waiting on the other side of the draw,
 * and neither of those is on the page when it only shows one week.
 *
 * Rounds are taken from the weeks the games are actually scheduled in
 * rather than from the configured round list -- a round that spans two
 * weeks is one round, and a bracket generated before the configuration
 * changed still draws correctly.
 *
 * The losers bracket is a separate tournament that happens to share a
 * calendar. Its rounds carry their own names, and its seeds are its own:
 * a team knocked out of the playoffs has a seed in each bracket.
 *
 * Two views over the same games. Desktop stacks the brackets, rounds as
 * columns, so the whole draw can be studied at once. The phone shows one
 * bracket at a time behind a switch, rounds stacked, opening on the
 * bracket the viewer's own team is playing in.
 */
export function PlayoffBracket({
  leagueId,
  matchups,
  teamById,
  myTeamId,
  seeds,
  losersMode,
  losersEnabled = false,
  losersStartWeek = null,
  selectedWeek,
  advancing,
}: {
  leagueId: string;
  matchups: Matchup[];
  teamById: Map<string, Team>;
  myTeamId: string | null;
  /** team id -> seed, per bracket. */
  seeds: { winners: Map<string, number>; losers: Map<string, number> };
  /** Names the losers bracket for what it decides. */
  losersMode: LosersMode;
  /** Whether the league runs a losers bracket, so one not yet drawn can say when it starts. */
  losersEnabled?: boolean;
  losersStartWeek?: number | null;
  /** The week picked above, so its round is marked in the draw. */
  selectedWeek: number;
  /** matchup id -> the team the database sends into the next round. */
  advancing: Map<string, string>;
}) {
  const brackets = bracketsOf(matchups, losersMode, losersEnabled, losersStartWeek);
  const shared = { leagueId, teamById, myTeamId, seeds, selectedWeek, advancing };

  return (
    <>
      <div className="hidden md:block">
        <BracketDesktop brackets={brackets} {...shared} />
      </div>
      <div className="md:hidden">
        <BracketMobile
          brackets={brackets}
          initial={openingBracket(matchups, myTeamId, selectedWeek)}
          {...shared}
        />
      </div>
    </>
  );
}

interface Shared {
  leagueId: string;
  teamById: Map<string, Team>;
  myTeamId: string | null;
  seeds: { winners: Map<string, number>; losers: Map<string, number> };
  selectedWeek: number;
  advancing: Map<string, string>;
}

interface BracketInfo {
  key: "winners" | "losers";
  title: string;
  /** Short name for the phone's switch. */
  tabLabel: string;
  blurb: string;
  losersAdvance: boolean;
  rounds: Round[];
  /** Set when the bracket is on but not drawn yet. */
  pending: string | null;
}

function bracketsOf(
  matchups: Matchup[],
  mode: LosersMode,
  losersEnabled: boolean,
  losersStartWeek: number | null,
): BracketInfo[] {
  const inBracket = (key: "winners" | "losers") =>
    matchups.filter((m) => (m.bracket ?? "winners") === key);

  const winners: BracketInfo = {
    key: "winners",
    title: "Championship bracket",
    tabLabel: "Championship",
    blurb: "The last team standing is champion.",
    losersAdvance: false,
    rounds: roundsOf(inBracket("winners")),
    pending: null,
  };

  const losersRounds = roundsOf(inBracket("losers"));
  const title =
    mode === "toilet_bowl"
      ? "Toilet bowl"
      : mode === "consolation"
        ? "Consolation bracket"
        : "Losers bracket";
  const losers: BracketInfo = {
    key: "losers",
    title,
    tabLabel:
      mode === "toilet_bowl"
        ? "Toilet bowl"
        : mode === "consolation"
          ? "Consolation"
          : "Losers",
    blurb:
      mode === "toilet_bowl"
        ? "Lose and you keep playing. The last team standing finishes last."
        : mode === "consolation"
          ? "The last team standing finishes best of the rest."
          : "A second bracket for teams out of the title race.",
    losersAdvance: mode === "toilet_bowl",
    rounds: losersRounds,
    pending:
      losersRounds.length === 0 && losersEnabled && losersStartWeek != null
        ? `Starts week ${losersStartWeek}. The matchups appear here once the teams going into it are known.`
        : null,
  };

  return [winners, losers].filter((b) => b.rounds.length > 0 || b.pending);
}

/**
 * Which bracket the phone opens on: the one the viewer's team is playing
 * in this week, else the one it played in last, else the championship.
 */
function openingBracket(
  matchups: Matchup[],
  myTeamId: string | null,
  week: number,
): "winners" | "losers" {
  if (!myTeamId) return "winners";
  const mine = matchups.filter(
    (m) => m.home_team_id === myTeamId || m.away_team_id === myTeamId,
  );
  const now = mine.find((m) => matchupCoversWeek(m, week));
  const latest = now ?? [...mine].sort((a, b) => b.week - a.week)[0];
  return latest?.bracket ?? "winners";
}

// Pieces -----------------------------------------------------------------------

function ModeBadge({ bracket }: { bracket: BracketInfo }) {
  return bracket.losersAdvance ? (
    <span className="badge-negative">
      <span aria-hidden>&darr;</span> Losers advance
    </span>
  ) : (
    <span className="pill">Winners advance</span>
  );
}

function RoundWeeks({ round, week }: { round: Round; week: number }) {
  // A multi-week round wears the same badge its games do; a single week
  // is just said.
  return round.weeks > 1 ? (
    <WeeksBadge matchup={{ week: round.week, week_count: round.weeks }} week={week} />
  ) : (
    <span className="text-xs text-muted tabular-nums">{round.weekLabel}</span>
  );
}

function Cards({
  bracket,
  round,
  compact,
  shared,
}: {
  bracket: BracketInfo;
  round: Round;
  compact: boolean;
  shared: Shared;
}) {
  return round.games.map((m) => (
    <MatchupCard
      key={m.id}
      leagueId={shared.leagueId}
      matchup={m}
      home={shared.teamById.get(m.home_team_id) ?? null}
      away={m.away_team_id ? (shared.teamById.get(m.away_team_id) ?? null) : null}
      mine={
        m.home_team_id === shared.myTeamId || m.away_team_id === shared.myTeamId
      }
      seeds={shared.seeds[bracket.key]}
      compact={compact}
      week={shared.selectedWeek}
      losersAdvance={bracket.losersAdvance}
      advancingTeamId={shared.advancing.get(m.id) ?? null}
    />
  ));
}

// Desktop ----------------------------------------------------------------------

function BracketDesktop({
  brackets,
  ...shared
}: Shared & { brackets: BracketInfo[] }) {
  // Only worth naming the bracket when there are two of them.
  const named = brackets.length > 1;

  return (
    <div className="space-y-8">
      {brackets.map((bracket, b) => (
        <section
          key={bracket.key}
          aria-label={bracket.title}
          className={`space-y-3 ${b > 0 ? "border-t border-border pt-6" : ""}`}
        >
          {named && (
            <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h2 className="h2">{bracket.title}</h2>
              <ModeBadge bracket={bracket} />
              <p className="muted w-full">{bracket.blurb}</p>
            </header>
          )}

          {bracket.pending ? (
            <p className="card muted">{bracket.pending}</p>
          ) : (
            <div className="table-scroll">
              <div className="flex items-stretch gap-3 pb-1">
                {bracket.rounds.map((round, index) => {
                  const current = round.contains(shared.selectedWeek);
                  return (
                    <div
                      key={round.week}
                      className="flex min-w-60 flex-1 basis-0 flex-col gap-3"
                    >
                      <div
                        aria-current={current ? "true" : undefined}
                        className={`space-y-1 rounded-md border px-2 py-1.5 ${
                          current ? "border-accent" : "border-border"
                        }`}
                      >
                        <p
                          className={`text-xs font-semibold tracking-wide uppercase ${
                            current ? "text-accent" : "text-muted"
                          }`}
                        >
                          {round.name}
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <RoundWeeks round={round} week={shared.selectedWeek} />
                          {bracket.losersAdvance && (
                            <span className="text-xs font-medium text-negative">
                              Loser goes through
                            </span>
                          )}
                        </div>
                      </div>

                      {/*
                        Spread down the column so a four-game round and the
                        two-game round beside it line up the way a drawn
                        bracket does, rather than both stacking at the top.
                      */}
                      <div
                        className={`flex flex-1 flex-col gap-3 ${
                          index === 0 ? "" : "justify-around"
                        }`}
                      >
                        <Cards
                          bracket={bracket}
                          round={round}
                          compact
                          shared={shared}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

// Phone ------------------------------------------------------------------------

function BracketMobile({
  brackets,
  initial,
  ...shared
}: Shared & { brackets: BracketInfo[]; initial: "winners" | "losers" }) {
  const panel = (bracket: BracketInfo, named: boolean) => (
    <div className="space-y-5">
      {named && (
        <div className="space-y-1">
          <ModeBadge bracket={bracket} />
          <p className="muted">{bracket.blurb}</p>
        </div>
      )}

      {bracket.pending ? (
        <p className="card muted">{bracket.pending}</p>
      ) : (
        bracket.rounds.map((round) => {
          const current = round.contains(shared.selectedWeek);
          return (
            <section
              key={round.week}
              aria-label={`${round.name}, ${round.weekLabel}`}
              className="space-y-2"
            >
              <div className="flex items-center gap-2">
                <h3
                  className={`min-w-0 flex-1 truncate text-sm font-semibold ${
                    current ? "text-accent" : ""
                  }`}
                >
                  {round.name}
                </h3>
                <RoundWeeks round={round} week={shared.selectedWeek} />
              </div>
              <div className="space-y-2">
                <Cards
                  bracket={bracket}
                  round={round}
                  compact={false}
                  shared={shared}
                />
              </div>
            </section>
          );
        })
      )}
    </div>
  );

  if (brackets.length < 2) {
    return brackets[0] ? panel(brackets[0], false) : null;
  }

  return (
    <BracketTabs
      initial={brackets.some((b) => b.key === initial) ? initial : "winners"}
      tabs={brackets.map((bracket) => ({
        key: bracket.key,
        label: bracket.tabLabel,
        content: panel(bracket, true),
      }))}
    />
  );
}

// Rounds -----------------------------------------------------------------------

interface Round {
  week: number;
  weeks: number;
  name: string;
  weekLabel: string;
  games: Matchup[];
  contains: (week: number) => boolean;
}

/**
 * Splits a bracket's games into rounds by the week they start in.
 *
 * The round's name is whichever label its games carry -- they all carry
 * the same one, except that a bye is always called "Bye", so that one
 * is the last resort rather than the first.
 */
function roundsOf(matchups: Matchup[]): Round[] {
  const byWeek = new Map<number, Matchup[]>();
  for (const m of matchups) {
    const list = byWeek.get(m.week) ?? [];
    list.push(m);
    byWeek.set(m.week, list);
  }

  return [...byWeek.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([week, games]) => {
      const weeks = Math.max(...games.map((m) => m.week_count ?? 1), 1);
      const span = { week, week_count: weeks };
      const named = games.find(
        (m) => m.playoff_round && m.playoff_round !== "Bye",
      );

      return {
        week,
        weeks,
        name: named?.playoff_round ?? games[0]?.playoff_round ?? `Week ${week}`,
        weekLabel: matchupSpanLabel(span),
        games: games.sort(bySeededOrder),
        contains: (w: number) => matchupCoversWeek(span, w),
      };
    });
}

/** Byes at the bottom; otherwise leave the generator's order alone. */
function bySeededOrder(a: Matchup, b: Matchup): number {
  return Number(a.away_team_id === null) - Number(b.away_team_id === null);
}
