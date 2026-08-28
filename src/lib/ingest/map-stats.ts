/**
 * Maps nflverse CSV columns onto the stat catalog's keys.
 *
 * Anything that is zero is dropped before storage: a jsonb map of only
 * the stats a player actually recorded is far smaller than 150 mostly
 * zero columns, and the scoring engine treats missing as zero anyway.
 */
import { n, type CsvRow } from "./csv.ts";

export type StatMap = Record<string, number>;

/** Drop zeroes and non-finite values so stored rows stay small. */
function compact(stats: StatMap): StatMap {
  const out: StatMap = {};
  for (const [key, value] of Object.entries(stats)) {
    if (!Number.isFinite(value)) continue;

    // Round before the zero check, not after: EPA arrives with fifteen
    // decimal places, and a value like 0.0012 would otherwise survive
    // the check and then be stored as 0 (or -0).
    const rounded = Math.round(value * 100) / 100;
    if (rounded === 0) continue;

    out[key] = rounded;
  }
  return out;
}

/** A milestone flag: 1 when the threshold is met, 0 otherwise. */
function flag(condition: boolean): number {
  return condition ? 1 : 0;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * One row of stats_player_week -> catalog keys.
 *
 * See src/lib/stats/catalog.ts for what each key means.
 */
export function mapPlayerWeek(row: CsvRow): StatMap {
  const attempts = n(row, "attempts");
  const completions = n(row, "completions");
  const passingYards = n(row, "passing_yards");
  const passingTds = n(row, "passing_tds");
  const interceptions = n(row, "passing_interceptions");

  const carries = n(row, "carries");
  const rushingYards = n(row, "rushing_yards");
  const rushingTds = n(row, "rushing_tds");

  const receptions = n(row, "receptions");
  const targets = n(row, "targets");
  const receivingYards = n(row, "receiving_yards");
  const receivingTds = n(row, "receiving_tds");

  const kickReturnYards = n(row, "kickoff_return_yards");
  const puntReturnYards = n(row, "punt_return_yards");
  const specialTeamsTds = n(row, "special_teams_tds");

  const tacklesSolo = n(row, "def_tackles_solo");
  const tacklesAssist = n(row, "def_tackle_assists");

  const defTds = n(row, "def_tds");
  const fumbleRecoveryTds = n(row, "fumble_recovery_tds");

  return compact({
    // --- Passing ------------------------------------------------------
    pass_attempts: attempts,
    pass_completions: completions,
    pass_incompletions: Math.max(0, attempts - completions),
    passing_yards: passingYards,
    passing_tds: passingTds,
    interceptions_thrown: interceptions,
    sacks_taken: n(row, "sacks_suffered"),
    sack_yards_lost: n(row, "sack_yards_lost"),
    passing_first_downs: n(row, "passing_first_downs"),
    passing_air_yards: n(row, "passing_air_yards"),
    passing_yards_after_catch: n(row, "passing_yards_after_catch"),
    pass_2pt_conversions: n(row, "passing_2pt_conversions"),
    passing_epa: n(row, "passing_epa"),
    pass_completion_20_plus: n(row, "passing_20"),
    pass_completion_40_plus: n(row, "passing_40"),
    cpoe: n(row, "passing_cpoe"),
    pacr: n(row, "pacr"),
    completion_pct: ratio(completions, attempts) * 100,
    yards_per_attempt: ratio(passingYards, attempts),

    pass_300_bonus: flag(passingYards >= 300),
    pass_400_bonus: flag(passingYards >= 400),
    pass_500_bonus: flag(passingYards >= 500),
    pass_4td_bonus: flag(passingTds >= 4),
    pass_6td_bonus: flag(passingTds >= 6),
    pass_clean_game: flag(attempts >= 20 && interceptions === 0),

    // --- Rushing ------------------------------------------------------
    rush_attempts: carries,
    rushing_yards: rushingYards,
    rushing_tds: rushingTds,
    rushing_first_downs: n(row, "rushing_first_downs"),
    rushing_epa: n(row, "rushing_epa"),
    rush_2pt_conversions: n(row, "rushing_2pt_conversions"),
    rushing_fumbles: n(row, "rushing_fumbles"),
    rushing_fumbles_lost: n(row, "rushing_fumbles_lost"),
    rush_10_plus: n(row, "rushing_10"),
    rush_20_plus: n(row, "rushing_20"),
    rush_40_plus: n(row, "rushing_40"),
    yards_per_carry: ratio(rushingYards, carries),

    rush_100_bonus: flag(rushingYards >= 100),
    rush_150_bonus: flag(rushingYards >= 150),
    rush_200_bonus: flag(rushingYards >= 200),
    rush_3td_bonus: flag(rushingTds >= 3),

    // --- Receiving ----------------------------------------------------
    targets,
    receptions,
    receiving_yards: receivingYards,
    receiving_tds: receivingTds,
    receiving_first_downs: n(row, "receiving_first_downs"),
    receiving_air_yards: n(row, "receiving_air_yards"),
    receiving_yards_after_catch: n(row, "receiving_yards_after_catch"),
    receiving_epa: n(row, "receiving_epa"),
    rec_2pt_conversions: n(row, "receiving_2pt_conversions"),
    receiving_fumbles: n(row, "receiving_fumbles"),
    receiving_fumbles_lost: n(row, "receiving_fumbles_lost"),
    rec_20_plus: n(row, "receiving_20"),
    rec_40_plus: n(row, "receiving_40"),
    racr: n(row, "racr"),
    target_share: n(row, "target_share"),
    air_yards_share: n(row, "air_yards_share"),
    wopr: n(row, "wopr"),
    yards_per_reception: ratio(receivingYards, receptions),
    yards_per_target: ratio(receivingYards, targets),

    rec_100_bonus: flag(receivingYards >= 100),
    rec_150_bonus: flag(receivingYards >= 150),
    rec_200_bonus: flag(receivingYards >= 200),
    rec_10_catch_bonus: flag(receptions >= 10),

    // --- Kicking ------------------------------------------------------
    fg_made: n(row, "fg_made"),
    fg_attempts: n(row, "fg_att"),
    fg_missed: n(row, "fg_missed"),
    fg_made_0_19: n(row, "fg_made_0_19"),
    fg_made_20_29: n(row, "fg_made_20_29"),
    fg_made_30_39: n(row, "fg_made_30_39"),
    fg_made_40_49: n(row, "fg_made_40_49"),
    fg_made_50_59: n(row, "fg_made_50_59"),
    fg_made_60_plus: n(row, "fg_made_60_"),
    // The catalog buckets misses more coarsely than nflverse does.
    fg_missed_0_39:
      n(row, "fg_missed_0_19") +
      n(row, "fg_missed_20_29") +
      n(row, "fg_missed_30_39"),
    fg_missed_40_49: n(row, "fg_missed_40_49"),
    fg_missed_50_plus: n(row, "fg_missed_50_59") + n(row, "fg_missed_60_"),
    fg_made_total_yards: n(row, "fg_made_distance"),
    fg_longest: n(row, "fg_long"),
    pat_made: n(row, "pat_made"),
    pat_attempts: n(row, "pat_att"),
    pat_missed: n(row, "pat_missed"),

    // --- Fumbles and returns ------------------------------------------
    fumbles: n(row, "fumbles_total"),
    fumbles_lost: n(row, "fumbles_lost_total"),
    fumble_recoveries_own: n(row, "fumble_recovery_own"),
    fumble_recovery_tds: fumbleRecoveryTds,
    kick_returns: n(row, "kickoff_returns"),
    kick_return_yards: kickReturnYards,
    punt_returns: n(row, "punt_returns"),
    punt_return_yards: puntReturnYards,
    special_teams_tds: specialTeamsTds,

    total_touches: carries + receptions,
    total_yards_from_scrimmage: rushingYards + receivingYards,
    all_purpose_yards:
      rushingYards + receivingYards + kickReturnYards + puntReturnYards,
    total_tds:
      rushingTds + receivingTds + specialTeamsTds + defTds + fumbleRecoveryTds,

    // --- IDP ----------------------------------------------------------
    tackles_solo: tacklesSolo,
    tackles_assist: tacklesAssist,
    tackles_combined: tacklesSolo + tacklesAssist,
    tackles_for_loss: n(row, "def_tackles_for_loss"),
    def_sacks: n(row, "def_sacks"),
    def_sack_yards: n(row, "def_sack_yards"),
    qb_hits: n(row, "def_qb_hits"),
    def_interceptions: n(row, "def_interceptions"),
    def_interception_yards: n(row, "def_interception_yards"),
    passes_defended: n(row, "def_pass_defended"),
    forced_fumbles: n(row, "def_fumbles_forced"),
    def_fumble_recoveries: n(row, "fumble_recovery_opp"),
    def_fumble_return_yards: n(row, "fumble_recovery_yards_opp"),
    def_safeties: n(row, "def_safeties"),
    def_blocked_kicks:
      n(row, "def_punt_blocks") +
      n(row, "def_pat_blocks") +
      n(row, "def_fg_blocks"),
    def_tds: defTds,
  });
}

/**
 * A team's own row from stats_team_week, read as its *defense*.
 *
 * Points and yards allowed are not in this row -- they come from the
 * game score and the opponent's own team row, so the caller supplies
 * them here.
 */
export function mapTeamDefense(
  row: CsvRow,
  allowed: {
    points: number;
    passYards: number;
    rushYards: number;
  },
): StatMap {
  const interceptions = n(row, "def_interceptions");
  const fumbleRecoveries = n(row, "fumble_recovery_opp");
  const totalYards = allowed.passYards + allowed.rushYards;
  const pa = allowed.points;

  return compact({
    dst_sacks: n(row, "def_sacks"),
    dst_interceptions: interceptions,
    dst_fumble_recoveries: fumbleRecoveries,
    dst_forced_fumbles: n(row, "def_fumbles_forced"),
    dst_safeties: n(row, "def_safeties"),
    dst_tds: n(row, "def_tds") + n(row, "special_teams_tds"),
    dst_blocked_kicks:
      n(row, "def_punt_blocks") +
      n(row, "def_pat_blocks") +
      n(row, "def_fg_blocks"),
    dst_tackles_for_loss: n(row, "def_tackles_for_loss"),
    dst_qb_hits: n(row, "def_qb_hits"),
    dst_passes_defended: n(row, "def_pass_defended"),
    dst_return_yards:
      n(row, "kickoff_return_yards") + n(row, "punt_return_yards"),
    dst_turnovers: interceptions + fumbleRecoveries,

    dst_points_allowed: pa,
    dst_yards_allowed: totalYards,
    dst_pass_yards_allowed: allowed.passYards,
    dst_rush_yards_allowed: allowed.rushYards,

    // Tiered bonuses, as 0/1 flags so a points-per-unit rule can express
    // "7 points for holding them to 1-6".
    dst_shutout: flag(pa === 0),
    dst_pa_0: flag(pa === 0),
    dst_pa_1_6: flag(pa >= 1 && pa <= 6),
    dst_pa_7_13: flag(pa >= 7 && pa <= 13),
    dst_pa_14_20: flag(pa >= 14 && pa <= 20),
    dst_pa_21_27: flag(pa >= 21 && pa <= 27),
    dst_pa_28_34: flag(pa >= 28 && pa <= 34),
    dst_pa_35_plus: flag(pa >= 35),

    dst_ya_under_100: flag(totalYards < 100),
    dst_ya_100_199: flag(totalYards >= 100 && totalYards <= 199),
    dst_ya_200_299: flag(totalYards >= 200 && totalYards <= 299),
    dst_ya_300_399: flag(totalYards >= 300 && totalYards <= 399),
    dst_ya_400_449: flag(totalYards >= 400 && totalYards <= 449),
    dst_ya_450_plus: flag(totalYards >= 450),
  });
}

/** Snap counts, keyed by pfr_player_id in the source file. */
export function mapSnapCounts(row: CsvRow): StatMap {
  return compact({
    offensive_snaps: n(row, "offense_snaps"),
    defensive_snaps: n(row, "defense_snaps"),
    snap_share: n(row, "offense_pct"),
  });
}

/** Pro Football Reference advanced rushing charting. */
export function mapAdvRush(row: CsvRow): StatMap {
  return compact({
    rush_yards_before_contact: n(row, "rushing_yards_before_contact"),
    rush_yards_after_contact: n(row, "rushing_yards_after_contact"),
    rush_broken_tackles: n(row, "rushing_broken_tackles"),
  });
}

/** Pro Football Reference advanced receiving charting. */
export function mapAdvRec(row: CsvRow): StatMap {
  return compact({ drops: n(row, "receiving_drop") });
}

/** Pro Football Reference advanced passing charting. */
export function mapAdvPass(row: CsvRow): StatMap {
  return compact({ qb_hurries: n(row, "times_hurried") });
}

/** Pro Football Reference advanced coverage charting. */
export function mapAdvDef(row: CsvRow): StatMap {
  return compact({
    def_targets: n(row, "def_targets"),
    def_completions_allowed: n(row, "def_completions_allowed"),
    def_yards_allowed: n(row, "def_yards_allowed"),
  });
}
