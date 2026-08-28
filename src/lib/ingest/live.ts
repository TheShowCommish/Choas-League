import "server-only";

import { createAdminClient } from "../supabase/admin.ts";
import { fetchBoxScore, fetchScoreboard, type EspnGame } from "./espn.ts";
import { currentSeason, normalizeTeam } from "./nflverse.ts";
import type { StatMap } from "./map-stats.ts";

/**
 * Live in-game scoring.
 *
 * Polls ESPN for games in progress, maps their box scores onto the stat
 * catalog and writes them with source = 'live'. The nflverse job later
 * replaces those rows with the authoritative numbers.
 *
 * The one rule that matters: a live row must never overwrite a final
 * one. Corrections land for days after a game, and ESPN's live feed is
 * both narrower and less accurate, so once nflverse has spoken we leave
 * that line alone.
 */

export interface LiveResult {
  job: string;
  rows: number;
  message?: string;
}

export async function syncLiveScores(): Promise<LiveResult> {
  const supabase = createAdminClient();
  const season = currentSeason();

  // Late games run past midnight UTC, so yesterday can still be live.
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 3600_000);

  const scoreboards = await Promise.all([
    fetchScoreboard(yesterday).catch(() => [] as EspnGame[]),
    fetchScoreboard(now).catch(() => [] as EspnGame[]),
  ]);

  const seen = new Set<string>();
  const games: EspnGame[] = [];
  for (const game of scoreboards.flat()) {
    if (seen.has(game.eventId)) continue;
    seen.add(game.eventId);
    // Games not yet kicked off have nothing to report.
    if (game.state === "pre") continue;
    games.push(game);
  }

  if (games.length === 0) {
    return { job: "live_scores", rows: 0, message: "No games in progress." };
  }

  // Match ESPN events to our schedule. nflverse carries the ESPN id, so
  // that is the reliable join; teams and week are the fallback.
  const { data: ourGames } = await supabase
    .from("nfl_games")
    .select("id, espn_id, week, home_team, away_team")
    .eq("season", season);

  const byEspnId = new Map<string, { id: string; week: number }>();
  const byTeams = new Map<string, { id: string; week: number }>();

  for (const game of ourGames ?? []) {
    const entry = { id: game.id as string, week: game.week as number };
    if (game.espn_id) byEspnId.set(String(game.espn_id), entry);
    byTeams.set(`${game.home_team}|${game.away_team}`, entry);
  }

  // ESPN athlete id -> our player id.
  const espnToPlayer = await loadEspnMap(supabase);

  const rows: Record<string, unknown>[] = [];
  const weeks = new Set<number>();
  const updatedGames: Record<string, unknown>[] = [];
  const now_iso = new Date().toISOString();

  for (const game of games) {
    const home = normalizeTeam(game.homeAbbr);
    const away = normalizeTeam(game.awayAbbr);

    const match =
      byEspnId.get(game.eventId) ?? byTeams.get(`${home}|${away}`);
    if (!match) continue;

    weeks.add(match.week);

    updatedGames.push({
      id: match.id,
      season,
      week: match.week,
      home_score: game.homeScore,
      away_score: game.awayScore,
      status: game.completed ? "final" : "in_progress",
      updated_at: now_iso,
    });

    // Which lines nflverse has already settled; leave those alone.
    const { data: finals } = await supabase
      .from("player_game_stats")
      .select("player_id")
      .eq("game_id", match.id)
      .eq("source", "final");

    const settled = new Set(
      (finals ?? []).map((r) => r.player_id as string),
    );

    let box;
    try {
      box = await fetchBoxScore(game.eventId);
    } catch {
      // One unavailable box score should not stop the rest of the slate.
      continue;
    }

    const add = (playerId: string, teamAbbr: string | null, stats: StatMap) => {
      if (settled.has(playerId)) return;
      if (Object.keys(stats).length === 0) return;

      rows.push({
        player_id: playerId,
        game_id: match.id,
        season,
        week: match.week,
        season_type: "REG",
        team_abbr: teamAbbr,
        opponent: teamAbbr === home ? away : home,
        source: "live",
        stats,
        updated_at: now_iso,
      });
    };

    for (const [espnId, stats] of box.players) {
      const playerId = espnToPlayer.get(espnId);
      if (!playerId) continue;
      add(playerId, null, stats);
    }

    for (const [abbr, stats] of box.defenses) {
      const team = normalizeTeam(abbr);
      if (!team) continue;
      add(`DST_${team}`, team, stats);
    }
  }

  if (updatedGames.length > 0) {
    await supabase.from("nfl_games").upsert(updatedGames, { onConflict: "id" });
  }

  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supabase
      .from("player_game_stats")
      .upsert(chunk, { onConflict: "player_id,game_id" });
    if (error) throw new Error(`Live stat upsert: ${error.message}`);
    written += chunk.length;
  }

  for (const week of weeks) {
    const { error } = await supabase.rpc("recompute_all_leagues", {
      p_season: season,
      p_week: week,
    });
    if (error) throw new Error(`Rescoring week ${week}: ${error.message}`);
  }

  return {
    job: "live_scores",
    rows: written,
    message: `${games.length} game(s), weeks ${[...weeks].join(", ")}`,
  };
}

async function loadEspnMap(
  supabase: ReturnType<typeof createAdminClient>,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("nfl_players")
      .select("id, espn_id")
      .not("espn_id", "is", null)
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`Reading espn ids: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const row of data) {
      map.set(String(row.espn_id), row.id as string);
    }
    if (data.length < pageSize) break;
  }

  return map;
}
