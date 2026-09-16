import type { Matchup, Team } from "@/lib/types";
import { MatchupCard } from "./matchup-card";

/**
 * The playoffs, drawn as a bracket.
 *
 * A week-at-a-time list is the right shape for a round robin and the
 * wrong one for a knockout: what a manager wants to know in December is
 * who they play next and who is waiting on the other side of the draw,
 * and neither of those is on the page when it only shows one week.
 *
 * Rounds are columns, taken from the weeks the games are actually
 * scheduled in rather than from the configured round list -- a round
 * that spans two weeks is one column, and a bracket generated before
 * the configuration changed still draws correctly.
 *
 * The consolation ladder is a second bracket underneath, because it is
 * a separate tournament that happens to share a calendar.
 */
export function PlayoffBracket({
  leagueId,
  matchups,
  teamById,
  myTeamId,
  seeds,
  selectedWeek,
}: {
  leagueId: string;
  matchups: Matchup[];
  teamById: Map<string, Team>;
  myTeamId: string | null;
  seeds: Map<string, number>;
  /** The week picked above, so its round is marked in the draw. */
  selectedWeek: number;
}) {
  const brackets: { key: "winners" | "losers"; title: string }[] = [
    { key: "winners", title: "Championship bracket" },
    { key: "losers", title: "Consolation bracket" },
  ];

  return (
    <div className="space-y-6">
      {brackets.map(({ key, title }) => {
        const inBracket = matchups.filter(
          (m) => (m.bracket ?? "winners") === key,
        );
        if (inBracket.length === 0) return null;

        return (
          <section key={key} className="space-y-2">
            {/* Only worth naming the bracket when there are two of them. */}
            {matchups.some((m) => (m.bracket ?? "winners") === "losers") && (
              <h2 className="h2">{title}</h2>
            )}

            <div className="table-scroll">
              <div className="flex items-stretch gap-3">
                {roundsOf(inBracket).map((round, index) => (
                  <div
                    key={round.week}
                    className="flex w-64 shrink-0 flex-col gap-3"
                  >
                    <div
                      className={`rounded-md border px-2 py-1 ${
                        round.contains(selectedWeek)
                          ? "border-accent text-accent"
                          : "border-border text-muted"
                      }`}
                    >
                      <p className="text-xs font-semibold tracking-wide uppercase">
                        {round.name}
                      </p>
                      <p className="text-xs">{round.weekLabel}</p>
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
                      {round.games.map((m) => (
                        <MatchupCard
                          key={m.id}
                          leagueId={leagueId}
                          matchup={m}
                          home={teamById.get(m.home_team_id) ?? null}
                          away={
                            m.away_team_id
                              ? (teamById.get(m.away_team_id) ?? null)
                              : null
                          }
                          mine={
                            m.home_team_id === myTeamId ||
                            m.away_team_id === myTeamId
                          }
                          seeds={seeds}
                          compact
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}

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
      const named = games.find(
        (m) => m.playoff_round && m.playoff_round !== "Bye",
      );

      return {
        week,
        weeks,
        name: named?.playoff_round ?? games[0]?.playoff_round ?? `Week ${week}`,
        weekLabel:
          weeks > 1
            ? `Weeks ${week}\u2013${week + weeks - 1}`
            : `Week ${week}`,
        games: games.sort(bySeededOrder),
        contains: (w: number) => w >= week && w < week + weeks,
      };
    });
}

/** Byes at the bottom; otherwise leave the generator's order alone. */
function bySeededOrder(a: Matchup, b: Matchup): number {
  return Number(a.away_team_id === null) - Number(b.away_team_id === null);
}
