/**
 * Play-by-play aggregation.
 *
 * The weekly box score files do not carry situational stats: red zone
 * targets, carries inside the five, deep attempts, three-and-outs. Those
 * only exist as properties of individual plays, so this walks every play
 * of the season and counts them up.
 *
 * This is the part that makes "score on anything" true rather than
 * nearly true. It is also the expensive part -- 50,000 plays and 372
 * columns a season -- so it streams the gzipped file and keeps only the
 * counters, never the plays.
 */
import { n, s, streamCsv } from "./csv.ts";
import { nflverseUrls, normalizeTeam } from "./nflverse.ts";
import type { StatMap } from "./map-stats.ts";

/** Keyed `${playerId}|${gameId}` or `DST_${team}|${gameId}`. */
export type PbpTotals = Map<string, StatMap>;

const REDZONE_YARDLINE = 20;
const GOAL_LINE_YARDLINE = 5;
const DEEP_AIR_YARDS = 20;
const LONG_TD_YARDS = 40;

/** Adds one to a counter, creating the row and key as needed. */
function bump(totals: PbpTotals, key: string, stat: string, by = 1) {
  if (by === 0) return;
  const row = totals.get(key) ?? {};
  row[stat] = (row[stat] ?? 0) + by;
  totals.set(key, row);
}

/**
 * Walks a season of plays and returns the situational counters.
 *
 * `week` of null does the whole season.
 */
export async function aggregatePlayByPlay(
  season: number,
  week: number | null,
): Promise<PbpTotals> {
  const totals: PbpTotals = new Map();

  // Drives are only recognisable as three-and-outs once seen whole, so
  // they are tallied separately and folded in at the end.
  const drives = new Map<
    string,
    { defense: string; gameId: string; playCount: number; result: string }
  >();

  for await (const play of streamCsv(nflverseUrls.playByPlay(season))) {
    if (week !== null && n(play, "week") !== week) continue;
    if ((s(play, "season_type") ?? "REG") === "PRE") continue;

    const gameId = s(play, "game_id");
    if (!gameId) continue;

    const defense = normalizeTeam(s(play, "defteam"));
    const yardline = n(play, "yardline_100");
    const airYards = n(play, "air_yards");
    const yardsGained = n(play, "yards_gained");
    const inRedZone = yardline > 0 && yardline <= REDZONE_YARDLINE;

    const isPass = n(play, "pass_attempt") === 1;
    const isRush = n(play, "rush_attempt") === 1;
    const complete = n(play, "complete_pass") === 1;

    // --- Passer -------------------------------------------------------
    const passer = s(play, "passer_player_id");
    if (passer && isPass) {
      const key = `${passer}|${gameId}`;
      if (airYards >= DEEP_AIR_YARDS) {
        bump(totals, key, "pass_attempts_deep");
        if (complete) bump(totals, key, "pass_completions_deep");
      }
      if (inRedZone) {
        bump(totals, key, "pass_attempts_redzone");
        if (n(play, "pass_touchdown") === 1) {
          bump(totals, key, "pass_tds_redzone");
        }
      }
      if (n(play, "pass_touchdown") === 1 && yardsGained >= LONG_TD_YARDS) {
        bump(totals, key, "pass_td_40_plus");
      }
    }

    // --- Receiver -----------------------------------------------------
    const receiver = s(play, "receiver_player_id");
    if (receiver && isPass) {
      const key = `${receiver}|${gameId}`;
      if (airYards >= DEEP_AIR_YARDS) bump(totals, key, "targets_deep");
      if (inRedZone) bump(totals, key, "targets_redzone");
      // A throw whose air yards reach the goal line is an end zone shot.
      if (yardline > 0 && airYards >= yardline) {
        bump(totals, key, "targets_endzone");
      }
      if (n(play, "pass_touchdown") === 1 && yardsGained >= LONG_TD_YARDS) {
        bump(totals, key, "rec_td_40_plus");
      }
    }

    // --- Rusher -------------------------------------------------------
    const rusher = s(play, "rusher_player_id");
    if (rusher && isRush) {
      const key = `${rusher}|${gameId}`;
      if (inRedZone) bump(totals, key, "rush_attempts_redzone");
      if (yardline > 0 && yardline <= GOAL_LINE_YARDLINE) {
        bump(totals, key, "rush_attempts_inside_5");
      }
      if (yardsGained <= 0) bump(totals, key, "rush_stuffed");
      if (n(play, "rush_touchdown") === 1 && yardsGained >= LONG_TD_YARDS) {
        bump(totals, key, "rush_td_40_plus");
      }
    }

    // --- Returners ----------------------------------------------------
    if (n(play, "return_touchdown") === 1) {
      const kickReturner = s(play, "kickoff_returner_player_id");
      const puntReturner = s(play, "punt_returner_player_id");
      if (kickReturner) {
        bump(totals, `${kickReturner}|${gameId}`, "kick_return_tds");
      }
      if (puntReturner) {
        bump(totals, `${puntReturner}|${gameId}`, "punt_return_tds");
      }
    }

    // --- Defenders ----------------------------------------------------
    if (isRush && n(play, "tackled_for_loss") === 1) {
      for (const column of [
        "tackle_for_loss_1_player_id",
        "tackle_for_loss_2_player_id",
      ]) {
        const tackler = s(play, column);
        if (tackler) bump(totals, `${tackler}|${gameId}`, "def_stuffs");
      }
    }

    // --- Team defense -------------------------------------------------
    if (defense) {
      const key = `DST_${defense}|${gameId}`;
      if (n(play, "first_down") === 1) {
        bump(totals, key, "dst_first_downs_allowed");
      }
      if (n(play, "fourth_down_failed") === 1) {
        bump(totals, key, "dst_fourth_down_stops");
      }

      const driveNumber = s(play, "fixed_drive");
      if (driveNumber) {
        drives.set(`${gameId}|${driveNumber}`, {
          defense,
          gameId,
          playCount: n(play, "drive_play_count"),
          result: s(play, "fixed_drive_result") ?? "",
        });
      }
    }
  }

  // A three-and-out is a drive that punted after three plays or fewer.
  for (const drive of drives.values()) {
    if (drive.result === "Punt" && drive.playCount > 0 && drive.playCount <= 3) {
      bump(totals, `DST_${drive.defense}|${drive.gameId}`, "dst_three_and_outs");
    }
  }

  return totals;
}
