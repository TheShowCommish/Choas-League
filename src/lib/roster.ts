import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { NflGame, NflPlayer, ScoreBreakdownEntry } from "@/lib/types";
import { positionRank } from "@/lib/roster-slots";
import { earliestGameByTeam } from "@/lib/lineup";

/** One rostered player, with everything the roster views need to show. */
export interface RosterEntry {
  playerId: string;
  player: NflPlayer;
  /** null when the player is not in this week's lineup at all. */
  slotKey: string | null;
  /**
   * He cannot move into or out of a starting slot this week: his game has
   * kicked off, or the league locks the whole lineup at the week's first
   * kickoff. The database's rule (lineup_locks, 0042), not just the stamp
   * the lock-lineups job leaves.
   */
  locked: boolean;
  /**
   * False for a player who has been dropped but is locked into this
   * week's starting lineup. His row stays, he still scores for this team
   * (team_week_points counts the lineup row, not the roster), so every
   * roster view has to draw him or the starters will not add up. He
   * cannot be moved, traded or dropped again.
   */
  onRoster: boolean;
  points: number;
  isFinal: boolean;
  breakdown: Record<string, ScoreBreakdownEntry>;
  /** This player's NFL game for the week, if his team is playing. */
  game: NflGame | null;
  opponent: string | null;
  acquiredVia: string;
}

/**
 * Loads a team's active roster for one week, joined to the player's
 * lineup slot, fantasy points and NFL game.
 *
 * A player whose NFL team has no game that week is on a bye -- `game`
 * stays null and the UI flags it.
 *
 * Returns the active roster plus anybody locked into this week's lineup
 * who is no longer on it -- a dropped locked starter (`onRoster` false).
 * Callers offering a player for something (a trade, a drop) filter those
 * out; callers drawing the week keep them.
 */
export async function getTeamRoster(
  leagueId: string,
  teamId: string,
  season: number,
  week: number,
): Promise<RosterEntry[]> {
  const supabase = await createClient();

  const [
    { data: roster },
    { data: lineup },
    { data: scores },
    { data: games },
    { data: locks },
  ] = await Promise.all([
      supabase
        .from("roster_players")
        .select("player_id, acquired_via, nfl_players(*)")
        .eq("team_id", teamId)
        .is("dropped_at", null),
      supabase
        .from("lineup_entries")
        .select("player_id, slot_key, locked_at, nfl_players(*)")
        .eq("team_id", teamId)
        .eq("season", season)
        .eq("week", week),
      supabase
        .from("player_week_scores")
        .select("player_id, points, is_final, breakdown")
        .eq("league_id", leagueId)
        .eq("season", season)
        .eq("week", week),
      supabase
        .from("nfl_games")
        .select("*")
        .eq("season", season)
        .eq("week", week),
      supabase.rpc("lineup_locks", {
        p_team: teamId,
        p_season: season,
        p_week: week,
      }),
    ]);

  const lockedPlayers = new Set(
    ((locks ?? []) as { player_id: string; locked: boolean }[])
      .filter((l) => l.locked)
      .map((l) => l.player_id),
  );

  const lineupByPlayer = new Map(
    (lineup ?? []).map((l) => [
      l.player_id as string,
      { slotKey: l.slot_key as string, locked: l.locked_at !== null },
    ]),
  );

  const scoreByPlayer = new Map(
    (scores ?? []).map((s) => [
      s.player_id as string,
      {
        points: Number(s.points),
        isFinal: s.is_final as boolean,
        breakdown: (s.breakdown ?? {}) as Record<string, ScoreBreakdownEntry>,
      },
    ]),
  );

  // The game a player's week turns on: his team's earliest kickoff, the
  // one the lock itself goes off.
  const gameByTeam = earliestGameByTeam((games ?? []) as NflGame[]);

  // The active roster, plus the dropped players this week's lineup is
  // still holding on to.
  const onRoster = new Set((roster ?? []).map((r) => r.player_id as string));
  const sources: { playerId: string; player: NflPlayer; acquiredVia: string }[] = [
    ...(roster ?? []).map((row) => ({
      playerId: row.player_id as string,
      player: row.nfl_players as unknown as NflPlayer,
      acquiredVia: row.acquired_via as string,
    })),
    ...(lineup ?? [])
      .filter(
        (row) =>
          !onRoster.has(row.player_id as string) &&
          lockedPlayers.has(row.player_id as string) &&
          row.nfl_players !== null,
      )
      .map((row) => ({
        playerId: row.player_id as string,
        player: row.nfl_players as unknown as NflPlayer,
        acquiredVia: "dropped",
      })),
  ];

  return sources
    .map(({ playerId, player, acquiredVia }): RosterEntry => {
      const entry = lineupByPlayer.get(playerId);
      const score = scoreByPlayer.get(playerId);
      const game = player.team_abbr
        ? (gameByTeam.get(player.team_abbr) ?? null)
        : null;

      const opponent = game
        ? game.home_team === player.team_abbr
          ? `vs ${game.away_team}`
          : `@ ${game.home_team}`
        : null;

      return {
        playerId,
        player,
        slotKey: entry?.slotKey ?? null,
        locked: lockedPlayers.has(playerId) || (entry?.locked ?? false),
        onRoster: onRoster.has(playerId),
        points: score?.points ?? 0,
        isFinal: score?.isFinal ?? false,
        breakdown: score?.breakdown ?? {},
        game,
        opponent,
        acquiredVia,
      };
    })
    .sort(sortRoster);
}

/** Position order first, then name -- the order a roster reads best in. */
function sortRoster(a: RosterEntry, b: RosterEntry): number {
  return (
    positionRank(a.player.position) - positionRank(b.player.position) ||
    a.player.full_name.localeCompare(b.player.full_name)
  );
}
