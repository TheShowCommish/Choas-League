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
  mapTeamOffense,
  type StatMap,
} from "./map-stats.ts";
import { aggregatePlayByPlay } from "./pbp.ts";
import { buildCoachGames, coachPlayerRows } from "./coaches.ts";
import {
  buildSleeperIdMap,
  fetchProjections,
  fetchSeasonProjections,
  fetchSleeperPlayers,
  injuriesFrom,
} from "./sleeper.ts";
import { PlayerIndex } from "./player-match.ts";
import { fetchEspnAdp } from "./espn-adp.ts";
import {
  fetchMockDraftAdp,
  matchMockAdp,
  type MatchablePlayer,
  type MatchedAdp,
} from "./mock-draft-adp.ts";

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

/**
 * Reads a whole table, a page at a time.
 *
 * PostgREST caps a response at 1000 rows and does it silently: no error,
 * no truncation flag, and `.limit(10000)` does not lift it -- the cap is
 * server-side. A plain `.select("id")` over nfl_players therefore hands
 * back the first thousand of three and a half thousand players and looks
 * exactly like a complete answer.
 *
 * That is not a hypothetical. It is why the first season-projection run
 * wrote 147 rows out of 3300: every player past the first page was
 * treated as somebody we had never heard of. Anything that needs "all
 * of them" has to page, and this is the one place that knows it.
 */
async function selectAll<T>(
  supabase: Admin,
  table: string,
  columns: string,
): Promise<T[]> {
  const out: T[] = [];
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`Reading ${table}: ${error.message}`);
    if (!data || data.length === 0) break;

    out.push(...(data as T[]));
    if (data.length < pageSize) break;
  }

  return out;
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

/**
 * Draft order: what rooms are actually doing, topped up from ESPN.
 *
 * The draft board opens on this. Sorting by last season's points sounds
 * reasonable and reads terribly: it buries every rookie, buries anybody
 * who missed the year, and puts a career-year tight end above a first
 * round running back.
 *
 * Two sources, and it is a blend rather than a choice:
 *
 *   Fantasy Football Calculator publishes ADP averaged over the public
 *   mock drafts it runs all summer -- eight thousand real drafts,
 *   refreshed daily. It is the better number by a distance, so wherever
 *   it has an opinion it wins. What it does not have is depth: a
 *   twelve-team fifteen-round board only ever names about 270 players.
 *
 *   ESPN covers twelve hundred. Its number is either a real average
 *   draft position or, outside its own drafting season, the editorial
 *   PPR draft rank that fetchEspnAdp falls back to. Either way it is
 *   the right shape -- roughly "which pick" -- so it fills in everybody
 *   the mock drafts never reached, and the late rounds have an order
 *   instead of an alphabet.
 *
 * The two scales are comparable by construction (both count picks from
 * one), but the stored rank is renumbered over the merged list so it
 * cannot disagree with the stored ADP. adp_source records which feed
 * each row came from.
 *
 * Both need the player table loaded first: the mock drafts match on
 * name and position, ESPN on the espn_id syncPlayers stores.
 */
export async function syncAdp(season: number): Promise<SyncResult> {
  const supabase = createAdminClient();

  return record(supabase, "sync_adp", season, null, async () => {
    const players = await loadMatchablePlayers(supabase);

    const mock = await tryMockDraftAdp(season, players);
    const espn = await tryEspnAdp(season, players);

    if (!mock && !espn) {
      return { rows: 0, message: "Neither source published an ADP." };
    }

    // Mock drafts first, so a player both feeds know keeps the number
    // that came out of a real room.
    const merged = new Map<string, MatchedAdp>();
    for (const row of mock?.rows ?? []) merged.set(row.id, row);
    for (const row of espn?.rows ?? []) {
      if (!merged.has(row.id)) merged.set(row.id, row);
    }

    const rows = [...merged.values()].sort((a, b) => a.adp - b.adp);
    rows.forEach((row, index) => {
      row.adp_rank = index + 1;
    });

    /*
     * An UPDATE, not an upsert.
     *
     * The obvious `upsert({ id, adp, ... }, { onConflict: "id" })` cannot
     * work here: Postgres validates the proposed row before it looks for
     * a conflict, so a payload without full_name trips that column's NOT
     * NULL constraint even though every one of these players already
     * exists. See 0035.
     */
    const { data: written, error } = await supabase.rpc("set_player_adp", {
      p_rows: rows,
    });

    if (error) throw new Error(`Writing ADP: ${error.message}`);

    const parts = [mock?.message, espn?.message].filter(Boolean);
    return {
      rows: Number(written ?? 0),
      message: `${parts.join("; ")}; ${written} written`,
    };
  });
}

/**
 * Sleeper's ids, resolved onto ours.
 *
 * Wanted by three jobs, and none of them can do it alone: it needs the
 * whole player table (paged), the whole Sleeper dump, and the matcher
 * that reconciles the two. Fetched once here rather than three times
 * over.
 */
async function sleeperMapping(supabase: Admin) {
  const players = await loadMatchablePlayers(supabase);
  const knownIds = new Set(players.map((p) => p.id));
  const rows = await fetchSleeperPlayers();
  const idMap = buildSleeperIdMap(rows, new PlayerIndex(players), knownIds);

  return { rows, idMap, knownIds };
}

/** Every player the ADP matchers might need to recognise. */
async function loadMatchablePlayers(
  supabase: Admin,
): Promise<(MatchablePlayer & { espn_id: string | null })[]> {
  return selectAll<MatchablePlayer & { espn_id: string | null }>(
    supabase,
    "nfl_players",
    "id, full_name, position, team_abbr, espn_id",
  );
}

/**
 * Mock-draft ADP, or null if there is none to be had.
 *
 * Deliberately swallows its own failure, as does its ESPN counterpart.
 * One unofficial third-party feed being down, or having no drafts yet
 * for a season that has only just turned over, is the ordinary case
 * rather than an error -- and there is a second source alongside it.
 */
async function tryMockDraftAdp(
  season: number,
  players: MatchablePlayer[],
): Promise<{ rows: MatchedAdp[]; message: string } | null> {
  let result;
  try {
    result = await fetchMockDraftAdp(season);
  } catch {
    return null;
  }

  if (result.entries.length === 0 || result.totalDrafts === 0) return null;

  const { rows, unmatched } = matchMockAdp(result, players);
  if (rows.length === 0) return null;

  return {
    rows,
    message:
      `${rows.length} from ${result.totalDrafts} ` +
      `${result.teams}-team ${result.scoring} mock drafts` +
      (unmatched.length > 0 ? ` (${unmatched.length} unknown to us)` : ""),
  };
}

/** ESPN's ordering, matched onto our ids by athlete id. */
async function tryEspnAdp(
  season: number,
  players: (MatchablePlayer & { espn_id: string | null })[],
): Promise<{ rows: MatchedAdp[]; message: string } | null> {
  let entries;
  try {
    entries = await fetchEspnAdp(season);
  } catch {
    return null;
  }

  if (entries.length === 0) return null;

  const byEspnId = new Map<string, string>();
  for (const player of players) {
    if (player.espn_id) byEspnId.set(String(player.espn_id), player.id);
  }

  const rows: MatchedAdp[] = [];
  const seen = new Set<string>();
  let unmatched = 0;

  for (const entry of entries) {
    const playerId = entry.defenseTeam
      ? `DST_${entry.defenseTeam}`
      : entry.espnId
        ? byEspnId.get(entry.espnId)
        : undefined;

    // Somebody ESPN carries and nflverse does not, or a player whose
    // espn_id we have never been given. Nothing to attach the number to.
    if (!playerId || seen.has(playerId)) {
      if (!playerId) unmatched++;
      continue;
    }

    seen.add(playerId);
    rows.push({
      id: playerId,
      adp: entry.adp,
      adp_rank: entry.rank,
      adp_source: entry.source,
    });
  }

  const source =
    entries[0].source === "espn" ? "live ADP" : "editorial draft rank";

  return {
    rows,
    message:
      `${rows.length} from ESPN by ${source}` +
      (unmatched > 0 ? ` (${unmatched} unknown to us)` : ""),
  };
}

/**
 * Weekly projections from Sleeper.
 *
 * Stored as a stat line rather than a points total so each league scores
 * it with its own rules -- see 0028. Also backfills nfl_players.sleeper_id
 * on the way through, since the mapping has to be fetched anyway and
 * nothing else populates that column.
 */
export async function syncProjections(
  season: number,
  week: number,
): Promise<SyncResult> {
  const supabase = createAdminClient();

  return record(supabase, "sync_projections", season, week, async () => {
    const { rows: dump, idMap, knownIds } = await sleeperMapping(supabase);

    /*
     * Backfill sleeper_id on the way through, since the mapping has to
     * be built anyway and nothing else populates that column.
     *
     * An update per row rather than an upsert: nfl_players.full_name is
     * NOT NULL and an upsert validates the proposed row before it looks
     * for a conflict. Same trap as ADP -- see 0035. Only rows whose
     * mapping is new are written.
     */
    const held = await selectAll<{ id: string; sleeper_id: string | null }>(
      supabase,
      "nfl_players",
      "id, sleeper_id",
    );
    const heldSleeperId = new Map(held.map((r) => [r.id, r.sleeper_id]));

    let mapped = 0;
    for (const [sleeperId, playerId] of idMap) {
      if (heldSleeperId.get(playerId) === sleeperId) continue;
      mapped++;
      const { error } = await supabase
        .from("nfl_players")
        .update({ sleeper_id: sleeperId })
        .eq("id", playerId);
      if (error) throw new Error(`sleeper_id backfill: ${error.message}`);
    }

    const projections = await fetchProjections(season, week, idMap);

    const rows = projections
      .filter((p) => knownIds.has(p.playerId))
      .map((p) => ({
        player_id: p.playerId,
        season,
        week,
        stats: p.stats,
        opponent: p.opponent,
        injury_status: p.injuryStatus,
        source: "sleeper",
        updated_at: new Date().toISOString(),
      }));

    const written = await upsertInBatches(
      supabase,
      "player_week_projections",
      rows,
      "player_id,season,week",
    );

    return {
      rows: written,
      message:
        `${written} of ${projections.length} projected players matched ` +
        `(${idMap.size} of ${dump.length} Sleeper ids resolved, ` +
        `${mapped} newly linked)`,
    };
  });
}

/**
 * A projection for the whole season, from Sleeper.
 *
 * This is the number a draft board wants. A weekly projection says
 * nothing useful in August, and last season's points say nothing about
 * a rookie -- what a manager reaching for a player in round three is
 * actually asking is "what does this year look like".
 *
 * Stored as a stat line for the same reason as the weekly one: points
 * belong to a league's rules, not to the feed. See 0036.
 */
export async function syncSeasonProjections(
  season: number,
): Promise<SyncResult> {
  const supabase = createAdminClient();

  return record(supabase, "sync_season_projections", season, null, async () => {
    const { rows: dump, idMap, knownIds } = await sleeperMapping(supabase);
    const projections = await fetchSeasonProjections(season, idMap);

    // Only players we hold: the table's foreign key would reject the
    // rest, and a college prospect is no use on a draft board anyway.
    const rows = projections
      .filter((p) => knownIds.has(p.playerId))
      .map((p) => ({
        player_id: p.playerId,
        season,
        stats: p.stats,
        source_points: p.sourcePoints,
        source: "sleeper",
        updated_at: new Date().toISOString(),
      }));

    const written = await upsertInBatches(
      supabase,
      "player_season_projections",
      rows,
      "player_id,season",
    );

    return {
      rows: written,
      message:
        `${written} of ${projections.length} projected players matched ` +
        `(${idMap.size} of ${dump.length} Sleeper ids resolved)`,
    };
  });
}

/**
 * Injuries, from Sleeper's player dump.
 *
 * Only players whose condition has actually changed are written. The
 * dump carries four thousand players and a handful of them are hurt, so
 * writing all four thousand rows to move six designations would be a
 * lot of traffic to say nothing.
 */
export async function syncInjuries(): Promise<SyncResult> {
  const supabase = createAdminClient();

  return record(supabase, "sync_injuries", null, null, async () => {
    const { rows: dump, idMap } = await sleeperMapping(supabase);
    const injuries = injuriesFrom(dump, idMap);

    const current = await selectAll<{
      id: string;
      injury_status: string | null;
      injury_body_part: string | null;
      injury_notes: string | null;
    }>(
      supabase,
      "nfl_players",
      "id, injury_status, injury_body_part, injury_notes",
    );

    const held = new Map(
      current.map((row) => [
        row.id,
        {
          status: row.injury_status ?? null,
          bodyPart: row.injury_body_part ?? null,
          notes: row.injury_notes ?? null,
        },
      ]),
    );

    const rows: Record<string, unknown>[] = [];
    let hurt = 0;

    for (const injury of injuries) {
      const was = held.get(injury.playerId);
      if (!was) continue;
      if (injury.status) hurt++;

      const unchanged =
        was.status === injury.status &&
        was.bodyPart === injury.bodyPart &&
        was.notes === injury.notes;
      if (unchanged) continue;

      rows.push({
        id: injury.playerId,
        injury_status: injury.status,
        injury_body_part: injury.bodyPart,
        injury_notes: injury.notes,
        injury_start_date: injury.startDate,
        practice_participation: injury.practice,
        injury_updated_at: new Date().toISOString(),
      });
    }

    // An update per changed row, not an upsert: nfl_players.full_name is
    // NOT NULL and an upsert validates the proposed row before it looks
    // for a conflict. Same trap as ADP -- see 0035.
    for (let i = 0; i < rows.length; i += BATCH) {
      for (const row of rows.slice(i, i + BATCH)) {
        const { id, ...fields } = row;
        const { error } = await supabase
          .from("nfl_players")
          .update(fields)
          .eq("id", id as string);
        if (error) throw new Error(`Injury for ${id}: ${error.message}`);
      }
    }

    return {
      rows: rows.length,
      message: `${hurt} players carrying a designation, ${rows.length} changed`,
    };
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

    // Play-by-play counters for team defenses and head coaches, folded
    // in once those rows are built further down.
    const pbpDefense = new Map<string, StatMap>();
    const pbpOffense = new Map<string, StatMap>();
    const pbpCoaches = new Map<string, StatMap>();

    // The charting feeds are keyed by pfr_player_id, so translate.
    const pfrToGsis = await loadPfrMap(supabase);

    await mergeByPfr(nflverseUrls.snapCounts(season), mapSnapCounts, "pfr_player_id");
    await mergeByPfr(nflverseUrls.advRush(season), mapAdvRush, "pfr_player_id");
    await mergeByPfr(nflverseUrls.advRec(season), mapAdvRec, "pfr_player_id");
    await mergeByPfr(nflverseUrls.advPass(season), mapAdvPass, "pfr_player_id");
    await mergeByPfr(nflverseUrls.advDef(season), mapAdvDef, "pfr_player_id");

    // Situational stats -- red zone targets, deep attempts, three-and-outs
    // -- exist only as properties of individual plays, so they come from
    // walking the play-by-play. Team defense rows are keyed the same way,
    // and are created here if the box score pass did not already make one.
    const pbp = await aggregatePlayByPlay(season, week);
    for (const [key, stats] of pbp) {
      const [playerId, gameId] = key.split("|");
      const games = byPlayer.get(playerId);

      if (games?.has(gameId)) {
        Object.assign(games.get(gameId)!, stats);
      } else if (playerId.startsWith("DST_")) {
        // D/ST lines are built later, so stash these for that pass.
        pbpDefense.set(key, stats);
      } else if (playerId.startsWith("OL_")) {
        pbpOffense.set(key, stats);
      } else if (playerId.startsWith("HC_")) {
        pbpCoaches.set(key, stats);
      }
    }

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

    // Stat rows reference both a player and a game, so both have to
    // exist or the whole batch fails on a foreign key.
    const known = await loadKnownPlayers(supabase, [...byPlayer.keys()]);
    const knownGames = await loadKnownGames(supabase, season);

    if (knownGames.size === 0) {
      throw new Error(
        `No games loaded for ${season}. Stats reference the schedule, so ` +
          `run "npm run ingest -- games" for that season first.`,
      );
    }

    const statRows: Record<string, unknown>[] = [];
    const now = new Date().toISOString();
    let skippedGames = 0;

    for (const [playerId, games] of byPlayer) {
      if (!known.has(playerId)) continue;

      for (const [gameId, stats] of games) {
        const info = meta.get(`${playerId}|${gameId}`);
        if (!info) continue;
        // A game we do not have: usually a preseason or postseason
        // fixture the schedule sync filtered out.
        if (!knownGames.has(gameId)) {
          skippedGames++;
          continue;
        }

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

    // One pass over the weekly team file produces both team units: a
    // D/ST reads it as what the opponent was allowed to do, an O-line as
    // what its own offense managed.
    const units = await buildTeamUnitRows(
      supabase, season, week, pbpDefense, pbpOffense,
    );
    const defenseRows = units.defense.filter((row) =>
      knownGames.has(row.game_id as string),
    );
    const offenseRows = units.offense.filter((row) =>
      knownGames.has(row.game_id as string),
    );

    // Head coaches. The pseudo-player rows go in first: a stat line
    // referencing HC_<abbr> needs that player to exist.
    const coachGames = await buildCoachGames(season, week, pbpCoaches);
    const coachPlayers = coachPlayerRows(coachGames);

    if (coachPlayers.length > 0) {
      await upsertInBatches(supabase, "nfl_players", coachPlayers, "id");
    }

    const coachRows = coachGames
      .filter((game) => knownGames.has(game.gameId))
      .map((game) => ({
        player_id: game.coachPlayerId,
        game_id: game.gameId,
        season: game.season,
        week: game.week,
        season_type: game.seasonType,
        team_abbr: game.team,
        opponent: game.opponent,
        source: "final",
        stats: game.stats,
        updated_at: now,
      }));

    const all = [...statRows, ...defenseRows, ...offenseRows, ...coachRows];

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
      message:
        `${statRows.length} player lines, ${defenseRows.length} D/ST, ` +
        `${offenseRows.length} O-lines, ${coachRows.length} coaches, ` +
        `${pbp.size} play-by-play totals, rescored ${weeks.length} week(s)` +
        (skippedGames > 0 ? `, skipped ${skippedGames} unknown games` : ""),
    };
  });
}

/**
 * Builds the two team-unit stat lines for a week.
 *
 * DST_<abbr> and OL_<abbr> both come out of the same weekly team file,
 * read from opposite ends: the defense's line is what the opponent was
 * allowed to do, the line's is what its own offense managed. Building
 * them together means streaming that file once rather than twice.
 */
async function buildTeamUnitRows(
  supabase: Admin,
  season: number,
  week: number | null,
  pbpDefense: Map<string, StatMap>,
  pbpOffense: Map<string, StatMap>,
): Promise<{
  defense: Record<string, unknown>[];
  offense: Record<string, unknown>[];
}> {
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

  if (teamRows.size === 0) return { defense: [], offense: [] };

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
  const defenseRows: Record<string, unknown>[] = [];
  const offenseRows: Record<string, unknown>[] = [];

  for (const [key, row] of teamRows) {
    const [team, gameId] = key.split("|");
    const opponent = normalizeTeam(s(row, "opponent_team"));
    if (!opponent) continue;

    const opponentOffense = offense.get(`${opponent}|${gameId}`);
    const pointsAllowed = scoreByTeamGame.get(key);

    // Without the opponent's row and a final score there is no defensive
    // line to write; skip rather than record a misleading shutout.
    if (!opponentOffense || pointsAllowed === undefined) continue;

    const common = {
      game_id: gameId,
      season: n(row, "season"),
      week: n(row, "week"),
      season_type: s(row, "season_type") ?? "REG",
      team_abbr: team,
      opponent,
      source: "final",
      updated_at: now,
    };

    defenseRows.push({
      ...common,
      player_id: `DST_${team}`,
      stats: {
        ...mapTeamDefense(row, {
          points: pointsAllowed,
          passYards: opponentOffense.passYards,
          rushYards: opponentOffense.rushYards,
        }),
        ...(pbpDefense.get(`DST_${team}|${gameId}`) ?? {}),
      },
    });

    // This team's own score is what the opponent was allowed.
    const pointsScored = scoreByTeamGame.get(`${opponent}|${gameId}`);
    if (pointsScored === undefined) continue;

    const lineStats: StatMap = {
      ...mapTeamOffense(row, { points: pointsScored }),
      ...(pbpOffense.get(`OL_${team}|${gameId}`) ?? {}),
    };

    // A clean pocket needs both halves -- sacks from the box score, hits
    // from the plays -- so it can only be worked out once they are
    // together.
    const dropbacks = lineStats.ol_dropbacks ?? 0;
    if (dropbacks > 0) {
      const pressures =
        (lineStats.ol_sacks_allowed ?? 0) + (lineStats.ol_qb_hits_allowed ?? 0);
      lineStats.ol_pressure_free_rate =
        Math.round(
          Math.max(0, (dropbacks - pressures) / dropbacks) * 10000,
        ) / 100;
    }

    offenseRows.push({
      ...common,
      player_id: `OL_${team}`,
      stats: lineStats,
    });
  }

  return { defense: defenseRows, offense: offenseRows };
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
/** The game ids we hold for a season, so stat rows can be filtered. */
async function loadKnownGames(
  supabase: Admin,
  season: number,
): Promise<Set<string>> {
  const known = new Set<string>();
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("nfl_games")
      .select("id")
      .eq("season", season)
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`Reading games: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const row of data) known.add(row.id as string);
    if (data.length < pageSize) break;
  }

  return known;
}

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
