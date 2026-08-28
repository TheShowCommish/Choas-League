import "server-only";

import { createAdminClient } from "../supabase/admin.ts";
import { n, s, streamCsv, type CsvRow } from "./csv.ts";
import { normalizeTeam, nflverseUrls } from "./nflverse.ts";
import {
  mapAdvDef,
  mapAdvPass,
  mapAdvRec,
  mapAdvRush,
  mapPlayerWeek,
  mapSnapCounts,
  mapTeamDefense,
  type StatMap,
} from "./map-stats.ts";

/**
 * The ingestion jobs.
 *
 * These run under the service role and bypass RLS -- they are the only
 * things that write NFL reference data. Everything is an upsert keyed on
 * a natural key, so a job can be re-run over the same week safely (and
 * often is: stat corrections land for days after a game).
 */

type Admin = ReturnType<typeof createAdminClient>;

/** Supabase rejects very large single statements; 500 rows is comfortable. */
const BATCH = 500;

export interface SyncResult {
  job: string;
  rows: number;
  message?: string;
}

async function upsertInBatches(
  supabase: Admin,
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
): Promise<number> {
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await supabase.from(table).upsert(chunk, { onConflict });
    if (error) {
      throw new Error(
        `${table} upsert failed at row ${i}: ${error.message}`,
      );
    }
    written += chunk.length;
  }
  return written;
}

/** Records what a job did, so the admin page can show ingestion health. */
async function record(
  supabase: Admin,
  job: string,
  season: number | null,
  week: number | null,
  run: () => Promise<{ rows: number; message?: string }>,
): Promise<SyncResult> {
  const { data: started } = await supabase
    .from("ingest_runs")
    .insert({ job, season, week, status: "running" })
    .select("id")
    .single();

  try {
    const { rows, message } = await run();
    if (started) {
      await supabase
        .from("ingest_runs")
        .update({
          status: "success",
          rows_written: rows,
          message: message ?? null,
          finished_at: new Date().toISOString(),
        })
        .eq("id", started.id);
    }
    return { job, rows, message };
  } catch (err) {
    const message = (err as Error).message;
    if (started) {
      await supabase
        .from("ingest_runs")
        .update({
          status: "error",
          message,
          finished_at: new Date().toISOString(),
        })
        .eq("id", started.id);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

/**
 * Refreshes the player table.
 *
 * players.csv carries every player in NFL history (~25k rows). Anyone
 * whose last season is two or more years ago cannot be rostered, so
 * they are skipped -- it keeps the table, and the free agency page,
 * to a few thousand relevant rows.
 */
export async function syncPlayers(season: number): Promise<SyncResult> {
  const supabase = createAdminClient();

  return record(supabase, "sync_players", season, null, async () => {
    const rows: Record<string, unknown>[] = [];

    for await (const row of streamCsv(nflverseUrls.players())) {
      const id = s(row, "gsis_id");
      if (!id) continue;

      const lastSeason = n(row, "last_season");
      if (lastSeason > 0 && lastSeason < season - 1) continue;

      rows.push({
        id,
        full_name: s(row, "display_name") ?? id,
        first_name: s(row, "first_name"),
        last_name: s(row, "last_name"),
        position: s(row, "position"),
        position_group: s(row, "position_group"),
        team_abbr: normalizeTeam(s(row, "latest_team")),
        jersey_number: n(row, "jersey_number") || null,
        status: s(row, "status"),
        height: s(row, "height"),
        weight: n(row, "weight") || null,
        college: s(row, "college_name"),
        birth_date: s(row, "birth_date"),
        years_exp: n(row, "years_of_experience") || null,
        headshot_url: s(row, "headshot"),
        espn_id: s(row, "espn_id"),
        pfr_id: s(row, "pfr_id"),
        last_season: lastSeason || null,
        updated_at: new Date().toISOString(),
      });
    }

    // A team_abbr we do not have breaks the foreign key; blank it rather
    // than dropping the player.
    const { data: teams } = await supabase.from("nfl_teams").select("abbr");
    const known = new Set((teams ?? []).map((t) => t.abbr as string));
    for (const row of rows) {
      if (row.team_abbr && !known.has(row.team_abbr as string)) {
        row.team_abbr = null;
      }
    }

    const written = await upsertInBatches(supabase, "nfl_players", rows, "id");
    return { rows: written };
  });
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

const GAME_TYPE_TO_SEASON_TYPE: Record<string, string> = {
  REG: "REG",
  PRE: "PRE",
  WC: "POST",
  DIV: "POST",
  CON: "POST",
  SB: "POST",
};

export async function syncGames(season: number): Promise<SyncResult> {
  const supabase = createAdminClient();

  return record(supabase, "sync_games", season, null, async () => {
    const rows: Record<string, unknown>[] = [];
    const playingByWeek = new Map<number, Set<string>>();

    for await (const row of streamCsv(nflverseUrls.games())) {
      if (n(row, "season") !== season) continue;

      const id = s(row, "game_id");
      const home = normalizeTeam(s(row, "home_team"));
      const away = normalizeTeam(s(row, "away_team"));
      if (!id || !home || !away) continue;

      const week = n(row, "week");
      const gameType = s(row, "game_type") ?? "REG";
      const homeScore = s(row, "home_score");
      const awayScore = s(row, "away_score");

      // gameday + gametime are local to the stadium; nflverse gives the
      // date and a 24h time, and every kickoff is US Eastern.
      const day = s(row, "gameday");
      const time = s(row, "gametime");
      const kickoff =
        day && time ? easternToUtc(`${day}T${time}:00`) : day ? `${day}T17:00:00Z` : null;

      rows.push({
        id,
        season,
        week,
        season_type: GAME_TYPE_TO_SEASON_TYPE[gameType] ?? "REG",
        home_team: home,
        away_team: away,
        kickoff_at: kickoff,
        home_score: homeScore === null ? null : Number(homeScore),
        away_score: awayScore === null ? null : Number(awayScore),
        status: homeScore === null ? "scheduled" : "final",
        espn_id: s(row, "espn"),
        updated_at: new Date().toISOString(),
      });

      if (GAME_TYPE_TO_SEASON_TYPE[gameType] === "REG") {
        const set = playingByWeek.get(week) ?? new Set<string>();
        set.add(home);
        set.add(away);
        playingByWeek.set(week, set);
      }
    }

    const written = await upsertInBatches(supabase, "nfl_games", rows, "id");

    // A team's bye is the regular season week it does not appear in.
    const { data: teams } = await supabase.from("nfl_teams").select("abbr");
    const allTeams = (teams ?? []).map((t) => t.abbr as string);
    const byes: Record<string, unknown>[] = [];

    for (const [week, playing] of playingByWeek) {
      for (const abbr of allTeams) {
        if (!playing.has(abbr)) byes.push({ season, week, team_abbr: abbr });
      }
    }

    if (byes.length > 0) {
      await supabase.from("nfl_byes").delete().eq("season", season);
      await upsertInBatches(supabase, "nfl_byes", byes, "season,team_abbr");
    }

    return { rows: written, message: `${byes.length} byes` };
  });
}

/**
 * nflverse gives kickoff as a local Eastern date and time. Converting
 * without a tz library: US Eastern is UTC-4 during the season (DST runs
 * to early November) and UTC-5 afterwards.
 */
function easternToUtc(local: string): string {
  const [datePart] = local.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const naive = new Date(`${local}Z`);

  // DST ends the first Sunday in November; before that, offset is 4.
  const isDst =
    month > 3 && (month < 11 || (month === 11 && day <= firstSunday(year, 11)));
  const offsetHours = isDst ? 4 : 5;

  return new Date(naive.getTime() + offsetHours * 3600_000).toISOString();
}

function firstSunday(year: number, month: number): number {
  const first = new Date(Date.UTC(year, month - 1, 1));
  return 1 + ((7 - first.getUTCDay()) % 7);
}

// ---------------------------------------------------------------------------
// Weekly stats
// ---------------------------------------------------------------------------

/**
 * Ingests one week of stats: the player box scores, the supplementary
 * charting feeds merged on top, and a D/ST line per team.
 *
 * Passing `week = null` does the whole season, which is what a backfill
 * or a mid-season deploy wants.
 */
export async function syncWeekStats(
  season: number,
  week: number | null,
): Promise<SyncResult> {
  const supabase = createAdminClient();

  return record(supabase, "sync_stats", season, week, async () => {
    const wanted = (row: CsvRow) =>
      (week === null || n(row, "week") === week) &&
      (s(row, "season_type") ?? "REG") !== "PRE";

    // player_id -> game_id -> stats
    const byPlayer = new Map<string, Map<string, StatMap>>();
    const meta = new Map<
      string,
      { season: number; week: number; seasonType: string; team: string | null; opponent: string | null }
    >();

    for await (const row of streamCsv(nflverseUrls.playerWeek(season))) {
      if (!wanted(row)) continue;

      const playerId = s(row, "player_id");
      const gameId = s(row, "game_id");
      if (!playerId || !gameId) continue;

      const games = byPlayer.get(playerId) ?? new Map<string, StatMap>();
      games.set(gameId, mapPlayerWeek(row));
      byPlayer.set(playerId, games);

      meta.set(`${playerId}|${gameId}`, {
        season: n(row, "season"),
        week: n(row, "week"),
        seasonType: s(row, "season_type") ?? "REG",
        team: normalizeTeam(s(row, "team")),
        opponent: normalizeTeam(s(row, "opponent_team")),
      });
    }

    if (byPlayer.size === 0) {
      return {
        rows: 0,
        message: `No player stats published yet for ${season}${week ? ` week ${week}` : ""}.`,
      };
    }

    // The charting feeds are keyed by pfr_player_id, so translate.
    const pfrToGsis = await loadPfrMap(supabase);

    await mergeByPfr(nflverseUrls.snapCounts(season), mapSnapCounts, "pfr_player_id");
    await mergeByPfr(nflverseUrls.advRush(season), mapAdvRush, "pfr_player_id");
    await mergeByPfr(nflverseUrls.advRec(season), mapAdvRec, "pfr_player_id");
    await mergeByPfr(nflverseUrls.advPass(season), mapAdvPass, "pfr_player_id");
    await mergeByPfr(nflverseUrls.advDef(season), mapAdvDef, "pfr_player_id");

    async function mergeByPfr(
      url: string,
      map: (row: CsvRow) => StatMap,
      idColumn: string,
    ) {
      for await (const row of streamCsv(url)) {
        if (!wanted(row)) continue;

        const pfrId = s(row, idColumn);
        const gameId = s(row, "game_id");
        if (!pfrId || !gameId) continue;

        const playerId = pfrToGsis.get(pfrId);
        if (!playerId) continue;

        // Only merge onto a line the box score already produced; a
        // charting row with no box score row is a player we do not have.
        const existing = byPlayer.get(playerId)?.get(gameId);
        if (!existing) continue;

        Object.assign(existing, map(row));
      }
    }

    // Only write stats for players we actually have rows for.
    const known = await loadKnownPlayers(supabase, [...byPlayer.keys()]);

    const statRows: Record<string, unknown>[] = [];
    const now = new Date().toISOString();

    for (const [playerId, games] of byPlayer) {
      if (!known.has(playerId)) continue;

      for (const [gameId, stats] of games) {
        const info = meta.get(`${playerId}|${gameId}`);
        if (!info) continue;

        statRows.push({
          player_id: playerId,
          game_id: gameId,
          season: info.season,
          week: info.week,
          season_type: info.seasonType,
          team_abbr: info.team,
          opponent: info.opponent,
          source: "final",
          stats,
          updated_at: now,
        });
      }
    }

    const defenseRows = await buildTeamDefenseRows(supabase, season, week);
    const all = [...statRows, ...defenseRows];

    const written = await upsertInBatches(
      supabase,
      "player_game_stats",
      all,
      "player_id,game_id",
    );

    // Fantasy points are stale the moment new stats land.
    const weeks =
      week === null
        ? [...new Set(all.map((r) => r.week as number))].sort((a, b) => a - b)
        : [week];

    for (const w of weeks) {
      const { error } = await supabase.rpc("recompute_all_leagues", {
        p_season: season,
        p_week: w,
      });
      if (error) throw new Error(`Rescoring week ${w}: ${error.message}`);
    }

    return {
      rows: written,
      message: `${statRows.length} player lines, ${defenseRows.length} D/ST, rescored ${weeks.length} week(s)`,
    };
  });
}

/** Builds the DST_<abbr> pseudo-player stat lines for a week. */
async function buildTeamDefenseRows(
  supabase: Admin,
  season: number,
  week: number | null,
): Promise<Record<string, unknown>[]> {
  // team|game -> its own offensive output, so we can read the opponent's
  // row as "yards allowed".
  const offense = new Map<string, { passYards: number; rushYards: number }>();
  const teamRows = new Map<string, CsvRow>();

  for await (const row of streamCsv(nflverseUrls.teamWeek(season))) {
    if (week !== null && n(row, "week") !== week) continue;
    if ((s(row, "season_type") ?? "REG") === "PRE") continue;

    const team = normalizeTeam(s(row, "team"));
    const gameId = s(row, "game_id");
    if (!team || !gameId) continue;

    const key = `${team}|${gameId}`;
    teamRows.set(key, row);
    offense.set(key, {
      passYards: n(row, "passing_yards"),
      rushYards: n(row, "rushing_yards"),
    });
  }

  if (teamRows.size === 0) return [];

  // Final scores, for points allowed.
  let gameQuery = supabase
    .from("nfl_games")
    .select("id, home_team, away_team, home_score, away_score")
    .eq("season", season);
  if (week !== null) gameQuery = gameQuery.eq("week", week);

  const { data: games } = await gameQuery;
  const scoreByTeamGame = new Map<string, number>();
  for (const g of games ?? []) {
    if (g.home_score === null || g.away_score === null) continue;
    // Points *allowed* is the other side's score.
    scoreByTeamGame.set(`${g.home_team}|${g.id}`, g.away_score as number);
    scoreByTeamGame.set(`${g.away_team}|${g.id}`, g.home_score as number);
  }

  const now = new Date().toISOString();
  const rows: Record<string, unknown>[] = [];

  for (const [key, row] of teamRows) {
    const [team, gameId] = key.split("|");
    const opponent = normalizeTeam(s(row, "opponent_team"));
    if (!opponent) continue;

    const opponentOffense = offense.get(`${opponent}|${gameId}`);
    const pointsAllowed = scoreByTeamGame.get(key);

    // Without the opponent's row and a final score there is no defensive
    // line to write; skip rather than record a misleading shutout.
    if (!opponentOffense || pointsAllowed === undefined) continue;

    rows.push({
      player_id: `DST_${team}`,
      game_id: gameId,
      season: n(row, "season"),
      week: n(row, "week"),
      season_type: s(row, "season_type") ?? "REG",
      team_abbr: team,
      opponent,
      source: "final",
      stats: mapTeamDefense(row, {
        points: pointsAllowed,
        passYards: opponentOffense.passYards,
        rushYards: opponentOffense.rushYards,
      }),
      updated_at: now,
    });
  }

  return rows;
}

async function loadPfrMap(supabase: Admin): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("nfl_players")
      .select("id, pfr_id")
      .not("pfr_id", "is", null)
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`Reading pfr ids: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const row of data) {
      map.set(row.pfr_id as string, row.id as string);
    }
    if (data.length < pageSize) break;
  }

  return map;
}

/**
 * Which of these player ids exist in nfl_players. A stat line for an
 * unknown player would violate the foreign key and fail the whole batch.
 */
async function loadKnownPlayers(
  supabase: Admin,
  ids: string[],
): Promise<Set<string>> {
  const known = new Set<string>();

  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const { data, error } = await supabase
      .from("nfl_players")
      .select("id")
      .in("id", chunk);

    if (error) throw new Error(`Checking players: ${error.message}`);
    for (const row of data ?? []) known.add(row.id as string);
  }

  return known;
}
