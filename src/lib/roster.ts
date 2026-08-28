import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { NflGame, NflPlayer, ScoreBreakdownEntry } from "@/lib/types";

/** One rostered player, with everything the roster views need to show. */
export interface RosterEntry {
  playerId: string;
  player: NflPlayer;
  /** null when the player is not in this week's lineup at all. */
  slotKey: string | null;
  locked: boolean;
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
 */
export async function getTeamRoster(
  leagueId: string,
  teamId: string,
  season: number,
  week: number,
): Promise<RosterEntry[]> {
  const supabase = await createClient();

  const [{ data: roster }, { data: lineup }, { data: scores }, { data: games }] =
    await Promise.all([
      supabase
        .from("roster_players")
        .select("player_id, acquired_via, nfl_players(*)")
        .eq("team_id", teamId)
        .is("dropped_at", null),
      supabase
        .from("lineup_entries")
        .select("player_id, slot_key, locked_at")
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
    ]);

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

  // An NFL team appears in at most one game a week.
  const gameByTeam = new Map<string, NflGame>();
  for (const g of (games ?? []) as NflGame[]) {
    if (g.home_team) gameByTeam.set(g.home_team, g);
    if (g.away_team) gameByTeam.set(g.away_team, g);
  }

  return (roster ?? [])
    .map((row): RosterEntry => {
      const player = row.nfl_players as unknown as NflPlayer;
      const entry = lineupByPlayer.get(row.player_id as string);
      const score = scoreByPlayer.get(row.player_id as string);
      const game = player.team_abbr
        ? (gameByTeam.get(player.team_abbr) ?? null)
        : null;

      const opponent = game
        ? game.home_team === player.team_abbr
          ? `vs ${game.away_team}`
          : `@ ${game.home_team}`
        : null;

      return {
        playerId: row.player_id as string,
        player,
        slotKey: entry?.slotKey ?? null,
        locked: entry?.locked ?? false,
        points: score?.points ?? 0,
        isFinal: score?.isFinal ?? false,
        breakdown: score?.breakdown ?? {},
        game,
        opponent,
        acquiredVia: row.acquired_via as string,
      };
    })
    .sort(sortRoster);
}

const POSITION_ORDER = ["QB", "RB", "WR", "TE", "K", "DEF", "DL", "LB", "DB"];

/** Position order first, then name -- the order a roster reads best in. */
function sortRoster(a: RosterEntry, b: RosterEntry): number {
  const ai = POSITION_ORDER.indexOf(a.player.position ?? "");
  const bi = POSITION_ORDER.indexOf(b.player.position ?? "");
  const aRank = ai === -1 ? POSITION_ORDER.length : ai;
  const bRank = bi === -1 ? POSITION_ORDER.length : bi;
  return aRank - bRank || a.player.full_name.localeCompare(b.player.full_name);
}
