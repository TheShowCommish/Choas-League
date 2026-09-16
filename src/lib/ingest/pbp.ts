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

/**
 * Keyed `${playerId}|${gameId}`, or `DST_${team}|${gameId}` and
 * `OL_${team}|${gameId}` for the two team units.
 */
export type PbpTotals = Map<string, StatMap>;

const REDZONE_YARDLINE = 20;
const GOAL_LINE_YARDLINE = 5;
const DEEP_AIR_YARDS = 20;
const LONG_TD_YARDS = 40;
const LONG_PUNT_YARDS = 50;

/**
 * The penalties an offensive line is responsible for.
 *
 * nflverse gives a free-text penalty_type, so this is a list rather than
 * a flag. Everything here is a flag thrown by somebody blocking; a
 * delay of game or an illegal forward pass is the quarterback's, and a
 * pass interference is the receiver's.
 */
const LINE_PENALTIES = new Set([
  "Offensive Holding",
  "False Start",
  "Illegal Formation",
  "Illegal Shift",
  "Illegal Motion",
  "Ineligible Downfield Pass",
  "Illegal Block Above the Waist",
  "Chop Block",
  "Tripping",
  "Offensive Too Many Men on Field",
  "Illegal Use of Hands",
]);

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

  // A comeback is only visible from the score as the fourth quarter
  // opens, which is a property of the game rather than of any one play.
  // Recorded on the first Q4 play seen, then resolved at the end.
  const fourthQuarter = new Map<
    string,
    { home: string; away: string; homeScore: number; awayScore: number }
  >();
  const finalScore = new Map<
    string,
    { home: string; away: string; homeScore: number; awayScore: number }
  >();

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

    // Score state, for the comeback. total_*_score is the score *before*
    // the play, which is exactly what "entering the quarter" means.
    const homeTeam = normalizeTeam(s(play, "home_team"));
    const awayTeam = normalizeTeam(s(play, "away_team"));
    if (homeTeam && awayTeam) {
      const scores = {
        home: homeTeam,
        away: awayTeam,
        homeScore: n(play, "total_home_score"),
        awayScore: n(play, "total_away_score"),
      };
      if (n(play, "qtr") === 4 && !fourthQuarter.has(gameId)) {
        fourthQuarter.set(gameId, scores);
      }
      // Every play overwrites, so the last one seen is the final score.
      finalScore.set(gameId, scores);
    }
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

    // --- Punter -------------------------------------------------------
    // The only place punting exists: the weekly player release has none.
    const punter = s(play, "punter_player_id");
    if (punter && s(play, "play_type") === "punt") {
      const key = `${punter}|${gameId}`;
      const distance = n(play, "punt_distance");

      bump(totals, key, "punts");
      bump(totals, key, "punt_yards", distance);
      if (distance >= LONG_PUNT_YARDS) bump(totals, key, "punt_50_plus");
      if (n(play, "punt_inside_twenty") === 1) {
        bump(totals, key, "punt_inside_20");
      }
      if (n(play, "punt_in_endzone") === 1 || n(play, "touchback") === 1) {
        bump(totals, key, "punt_touchbacks");
      }
      if (n(play, "punt_fair_catch") === 1) {
        bump(totals, key, "punt_fair_catches");
      }
      if (n(play, "punt_blocked") === 1) bump(totals, key, "punts_blocked");
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

    // --- Offensive line -----------------------------------------------
    // The line has no box score anywhere, so its whole stat line is
    // counted here: pressure the quarterback took, runs stopped at the
    // line, chains moved, and the flags a line throws.
    const offense = normalizeTeam(s(play, "posteam"));
    if (offense && (isPass || isRush)) {
      const key = `OL_${offense}|${gameId}`;

      bump(totals, key, "ol_offensive_snaps");
      if (n(play, "qb_hit") === 1) bump(totals, key, "ol_qb_hits_allowed");
      if (isRush && yardsGained <= 0) bump(totals, key, "ol_stuffs_allowed");
      if (n(play, "down") === 3 && n(play, "third_down_converted") === 1) {
        bump(totals, key, "ol_third_down_conversions");
      }
      if (
        inRedZone &&
        (n(play, "rush_touchdown") === 1 || n(play, "pass_touchdown") === 1)
      ) {
        bump(totals, key, "ol_red_zone_tds");
      }
    }

    // A penalty is not a pass or a rush, so this sits outside the block
    // above -- a false start happens before there is a play at all.
    if (offense && n(play, "penalty") === 1) {
      const flaggedTeam = normalizeTeam(s(play, "penalty_team"));
      const type = s(play, "penalty_type") ?? "";

      if (flaggedTeam === offense && LINE_PENALTIES.has(type)) {
        const key = `OL_${offense}|${gameId}`;
        bump(totals, key, "ol_penalties");
        if (type === "False Start") bump(totals, key, "ol_false_starts");
        if (type === "Offensive Holding") {
          bump(totals, key, "ol_holding_penalties");
        }
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

  // Trailing as the fourth quarter began, and won.
  for (const [gameId, start] of fourthQuarter) {
    const end = finalScore.get(gameId);
    if (!end) continue;

    const homeTrailed = start.homeScore < start.awayScore;
    const awayTrailed = start.awayScore < start.homeScore;
    const homeWon = end.homeScore > end.awayScore;
    const awayWon = end.awayScore > end.homeScore;

    if (homeTrailed && homeWon) {
      bump(totals, `HC_${start.home}|${gameId}`, "coach_comeback_4q");
    }
    if (awayTrailed && awayWon) {
      bump(totals, `HC_${start.away}|${gameId}`, "coach_comeback_4q");
    }
  }

  return totals;
}
