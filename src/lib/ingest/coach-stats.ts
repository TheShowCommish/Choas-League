/**
 * Turning a season of results into a head coach's weekly stat lines.
 *
 * Split from coaches.ts, which reaches for the network and is therefore
 * server-only: this half is arithmetic, and can be tested directly in
 * the same way pbp.ts and map-stats.ts are.
 *
 * A coach is a pseudo-player with id `HC_<abbr>` and position 'HC', the
 * same trick the app already plays for a D/ST (`DST_<abbr>`, 'DEF'), so
 * every roster, lineup, draft, waiver and trade query stays single-path:
 * a coach is drafted and started like anybody else.
 *
 * His stats are his team's, because what the team did is what the coach
 * did. Streaks are the awkward ones -- they depend on earlier weeks,
 * while the scoring engine only ever multiplies one game's stat by a
 * rule. So the season is walked in order and each result is written with
 * how many games into a run it left him: a figure that describes one
 * game, and scores like any other.
 */
import type { StatMap } from "./map-stats.ts";

export interface TeamBoxScore {
  yards: number;
  committed: number;
  forced: number;
}

/** One team's side of one game, from the schedule. */
export interface Fixture {
  gameId: string;
  season: number;
  week: number;
  seasonType: string;
  team: string;
  opponent: string;
  coach: string;
  pointsFor: number;
  pointsAgainst: number;
  played: boolean;
}

export interface CoachGame {
  coachPlayerId: string;
  coachName: string;
  team: string;
  gameId: string;
  season: number;
  week: number;
  seasonType: string;
  opponent: string;
  stats: StatMap;
}

/**
 * A coach's stat line for each game.
 *
 * `comebacks` is keyed `HC_<abbr>|<gameId>` and comes from the
 * play-by-play pass, the only place quarter-by-quarter score state
 * exists.
 */
export function buildCoachStats(
  fixtures: Fixture[],
  box: Map<string, TeamBoxScore>,
  comebacks: Map<string, StatMap>,
  week: number | null,
): CoachGame[] {
  // Streaks need the season in order and every week of it, so the whole
  // season is walked even when one week is being written. The filter
  // comes afterwards.
  const ordered = [...fixtures].sort(
    (a, b) => a.week - b.week || a.gameId.localeCompare(b.gameId),
  );

  const winStreak = new Map<string, number>();
  const lossStreak = new Map<string, number>();
  const out: CoachGame[] = [];

  for (const fixture of ordered) {
    // An unplayed fixture must not break a streak, so it is skipped
    // before any counter moves.
    if (!fixture.played) continue;

    const won = fixture.pointsFor > fixture.pointsAgainst;
    const lost = fixture.pointsFor < fixture.pointsAgainst;
    const margin = fixture.pointsFor - fixture.pointsAgainst;

    // Streaks follow the coach, not the club: a coach sacked in October
    // does not hand his run to whoever takes over.
    const key = fixture.coach;
    if (won) {
      winStreak.set(key, (winStreak.get(key) ?? 0) + 1);
      lossStreak.set(key, 0);
    } else if (lost) {
      lossStreak.set(key, (lossStreak.get(key) ?? 0) + 1);
      winStreak.set(key, 0);
    } else {
      // A tie ends both runs without starting one.
      winStreak.set(key, 0);
      lossStreak.set(key, 0);
    }

    if (week !== null && fixture.week !== week) continue;

    const coachPlayerId = `HC_${fixture.team}`;
    const boxScore = box.get(`${fixture.team}|${fixture.gameId}`);

    const stats: StatMap = {
      coach_win: won ? 1 : 0,
      coach_loss: lost ? 1 : 0,
      coach_tie: !won && !lost ? 1 : 0,
      // Both margins are positive numbers, so a league can price a
      // thrashing and a hammering separately without one rule having to
      // cope with a sign change.
      coach_win_margin: won ? margin : 0,
      coach_loss_margin: lost ? -margin : 0,
      coach_points_scored: fixture.pointsFor,
      coach_offensive_yards: boxScore?.yards ?? 0,
      coach_turnovers_committed: boxScore?.committed ?? 0,
      coach_turnovers_forced: boxScore?.forced ?? 0,
      coach_win_streak: winStreak.get(key) ?? 0,
      coach_loss_streak: lossStreak.get(key) ?? 0,
    };

    const comeback = comebacks.get(`${coachPlayerId}|${fixture.gameId}`);
    if (comeback) Object.assign(stats, comeback);

    out.push({
      coachPlayerId,
      coachName: fixture.coach,
      team: fixture.team,
      gameId: fixture.gameId,
      season: fixture.season,
      week: fixture.week,
      seasonType: fixture.seasonType,
      opponent: fixture.opponent,
      stats,
    });
  }

  return out;
}

/**
 * The pseudo-player rows, named for whoever currently holds the job.
 *
 * A coach sacked mid-season leaves HC_<abbr> pointing at his
 * replacement, which is the right answer for a fantasy roster: the slot
 * is the job, not the man.
 */
export function coachPlayerRows(games: CoachGame[]): Record<string, unknown>[] {
  const latest = new Map<string, { name: string; week: number; team: string }>();

  for (const game of games) {
    const held = latest.get(game.coachPlayerId);
    if (!held || game.week >= held.week) {
      latest.set(game.coachPlayerId, {
        name: game.coachName,
        week: game.week,
        team: game.team,
      });
    }
  }

  return [...latest].map(([id, { name, team }]) => ({
    id,
    full_name: `${name} (HC)`,
    position: "HC",
    team_abbr: team,
    updated_at: new Date().toISOString(),
  }));
}
