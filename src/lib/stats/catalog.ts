/**
 * The stat catalog.
 *
 * Single source of truth for every stat this app can ingest and score on.
 * Three consumers read from here:
 *   1. the ingestion jobs, which produce exactly these keys
 *   2. the admin scoring page, which renders one row per entry
 *   3. scripts/generate-stat-seed.mjs, which emits the DB seed migration
 *
 * valueType:
 *   count -> an additive tally (yards, receptions). Points = value * rule.
 *   flag  -> 0 or 1, emitted when a condition is met. Lets a points-per-unit
 *            model express milestone bonuses ("100+ rushing yards: +3").
 *   rate  -> informational only (percentages, EPA-per-play). Not scorable,
 *            because averaging across games is not the same as summing.
 */

export type StatAppliesTo = "player" | "team_defense";
export type StatValueType = "count" | "flag" | "rate";

/**
 * Where a stat comes from. All of these are ingested, except for the
 * handful listed in UNAVAILABLE below, which no free feed carries.
 */
export type StatSource =
  | "player" // nflverse stats_player_week
  | "team" // nflverse stats_team_week + schedules
  | "pfr" // Pro Football Reference advanced weekly stats
  | "snaps" // nflverse snap counts
  | "derived" // computed from the above during ingestion
  | "pbp"; // aggregated from nflverse play-by-play

export interface StatDefinition {
  key: string;
  label: string;
  category: string;
  description: string;
  appliesTo: StatAppliesTo;
  valueType: StatValueType;
  /** Seeded into every new league's scoring rules. 0 = stat is off by default. */
  defaultPoints: number;
  scorable: boolean;
  source: StatSource;
  /**
   * False when no feed we ingest carries this stat, so the admin UI can
   * say so rather than letting a commissioner switch on a stat that
   * would silently never score.
   */
  tracked: boolean;
}

type Row = [
  key: string,
  label: string,
  description: string,
  valueType: StatValueType,
  defaultPoints: number,
];

/** Stats sourced from somewhere other than stats_player_week. */
const SOURCE_OVERRIDES: Record<string, StatSource> = Object.fromEntries([
  // Pro Football Reference advanced weekly charting.
  ...[
    "rush_yards_before_contact",
    "rush_yards_after_contact",
    "rush_broken_tackles",
    "drops",
    "qb_hurries",
    "def_targets",
    "def_completions_allowed",
    "def_yards_allowed",
  ].map((k) => [k, "pfr" as StatSource]),

  // Snap count release.
  ...["offensive_snaps", "defensive_snaps", "snap_share"].map(
    (k) => [k, "snaps" as StatSource],
  ),

  // Computed during ingestion from the columns above.
  ...[
    "pass_incompletions",
    "total_touches",
    "total_yards_from_scrimmage",
    "all_purpose_yards",
    "total_tds",
    "fumbles",
    "fumbles_lost",
    "tackles_combined",
    "fg_made_total_yards",
    "completion_pct",
    "yards_per_attempt",
    "yards_per_carry",
    "yards_per_reception",
    "yards_per_target",
    "passer_rating",
    "pass_300_bonus",
    "pass_400_bonus",
    "pass_500_bonus",
    "pass_4td_bonus",
    "pass_6td_bonus",
    "pass_clean_game",
    "rush_100_bonus",
    "rush_150_bonus",
    "rush_200_bonus",
    "rush_3td_bonus",
    "rec_100_bonus",
    "rec_150_bonus",
    "rec_200_bonus",
    "rec_10_catch_bonus",
  ].map((k) => [k, "derived" as StatSource]),

  // Only obtainable by aggregating play-by-play.
  ...[
    // nflverse reports one combined special_teams_tds figure, so
    // splitting it back into kick and punt returns needs play-by-play.
    "kick_return_tds",
    "punt_return_tds",
    "pass_attempts_deep",
    "pass_completions_deep",
    "pass_attempts_redzone",
    "pass_tds_redzone",
    "pass_td_40_plus",
    "rush_td_40_plus",
    "rec_td_40_plus",
    "rush_attempts_redzone",
    "rush_attempts_inside_5",
    "rush_stuffed",
    "targets_redzone",
    "targets_endzone",
    "targets_deep",
    "def_stuffs",
    "dst_three_and_outs",
    "dst_fourth_down_stops",
    "dst_first_downs_allowed",
  ].map((k) => [k, "pbp" as StatSource]),
]);

/**
 * Stats in the catalog that nothing we ingest actually carries.
 *
 * Rush yards over expected comes from Next Gen Stats tracking data,
 * which nflverse does not publish per week. It stays in the catalog
 * because it is worth having if a source appears, but the admin UI
 * marks it so nobody switches it on and waits all season for a score
 * that cannot come.
 */
const UNAVAILABLE = new Set(["rush_yards_over_expected"]);

function group(
  category: string,
  appliesTo: StatAppliesTo,
  rows: Row[],
): StatDefinition[] {
  return rows.map(([key, label, description, valueType, defaultPoints]) => {
    const source =
      SOURCE_OVERRIDES[key] ??
      (appliesTo === "team_defense" ? "team" : "player");

    return {
      key,
      label,
      category,
      description,
      appliesTo,
      valueType,
      defaultPoints,
      scorable: valueType !== "rate",
      source,
      tracked: !UNAVAILABLE.has(key),
    };
  });
}

// ---------------------------------------------------------------------------
// Passing
// ---------------------------------------------------------------------------
const PASSING = group("Passing", "player", [
  ["pass_attempts", "Pass Attempts", "Total pass attempts.", "count", 0],
  ["pass_completions", "Completions", "Completed passes.", "count", 0],
  ["pass_incompletions", "Incompletions", "Attempts minus completions.", "count", 0],
  ["passing_yards", "Passing Yards", "Net passing yards.", "count", 0.04],
  ["passing_tds", "Passing TDs", "Touchdown passes thrown.", "count", 4],
  ["interceptions_thrown", "Interceptions Thrown", "Passes intercepted.", "count", -2],
  ["sacks_taken", "Sacks Taken", "Times sacked.", "count", 0],
  ["sack_yards_lost", "Sack Yards Lost", "Yards lost to sacks.", "count", 0],
  ["passing_first_downs", "Passing First Downs", "First downs gained through the air.", "count", 0],
  ["passing_air_yards", "Passing Air Yards", "Total air yards on all attempts.", "count", 0],
  ["passing_yards_after_catch", "Passing YAC", "Yards after catch on completions.", "count", 0],
  ["pass_2pt_conversions", "2PT Pass Conversions", "Successful two-point conversion passes.", "count", 2],
  ["passing_epa", "Passing EPA", "Expected points added passing. Can be negative.", "count", 0],
  ["pass_td_40_plus", "Pass TDs 40+ Yards", "Touchdown passes of 40 or more yards.", "count", 0],
  ["pass_completion_40_plus", "Completions 40+ Yards", "Completions of 40 or more yards.", "count", 0],
  ["pass_completion_20_plus", "Completions 20+ Yards", "Completions of 20 or more yards.", "count", 0],
  ["pass_attempts_deep", "Deep Attempts", "Attempts travelling 20+ air yards.", "count", 0],
  ["pass_completions_deep", "Deep Completions", "Completions travelling 20+ air yards.", "count", 0],
  ["pass_attempts_redzone", "Red Zone Attempts", "Pass attempts inside the opponent 20.", "count", 0],
  ["pass_tds_redzone", "Red Zone Pass TDs", "Touchdown passes thrown from inside the 20.", "count", 0],
  ["pass_300_bonus", "300+ Passing Yards", "Bonus when a passer clears 300 yards.", "flag", 0],
  ["pass_400_bonus", "400+ Passing Yards", "Bonus when a passer clears 400 yards.", "flag", 0],
  ["pass_500_bonus", "500+ Passing Yards", "Bonus when a passer clears 500 yards.", "flag", 0],
  ["pass_4td_bonus", "4+ Passing TDs", "Bonus for four or more passing touchdowns.", "flag", 0],
  ["pass_6td_bonus", "6+ Passing TDs", "Bonus for six or more passing touchdowns.", "flag", 0],
  ["pass_clean_game", "No-Interception Game", "Bonus for 20+ attempts with zero picks.", "flag", 0],
  ["completion_pct", "Completion %", "Completions divided by attempts.", "rate", 0],
  ["yards_per_attempt", "Yards / Attempt", "Passing yards per attempt.", "rate", 0],
  ["passer_rating", "Passer Rating", "Traditional NFL passer rating.", "rate", 0],
  ["cpoe", "CPOE", "Completion percentage over expected.", "rate", 0],
  ["pacr", "PACR", "Passing air conversion ratio.", "rate", 0],
]);

// ---------------------------------------------------------------------------
// Rushing
// ---------------------------------------------------------------------------
const RUSHING = group("Rushing", "player", [
  ["rush_attempts", "Rush Attempts", "Carries.", "count", 0],
  ["rushing_yards", "Rushing Yards", "Net rushing yards.", "count", 0.1],
  ["rushing_tds", "Rushing TDs", "Rushing touchdowns.", "count", 6],
  ["rushing_first_downs", "Rushing First Downs", "First downs gained on the ground.", "count", 0],
  ["rushing_epa", "Rushing EPA", "Expected points added rushing. Can be negative.", "count", 0],
  ["rush_2pt_conversions", "2PT Rush Conversions", "Successful two-point conversion runs.", "count", 2],
  ["rushing_fumbles", "Rushing Fumbles", "Fumbles on rushing plays.", "count", 0],
  ["rushing_fumbles_lost", "Rushing Fumbles Lost", "Rushing fumbles recovered by the defense.", "count", 0],
  ["rush_10_plus", "Rushes 10+ Yards", "Carries gaining 10 or more yards.", "count", 0],
  ["rush_20_plus", "Rushes 20+ Yards", "Carries gaining 20 or more yards.", "count", 0],
  ["rush_40_plus", "Rushes 40+ Yards", "Carries gaining 40 or more yards.", "count", 0],
  ["rush_td_40_plus", "Rush TDs 40+ Yards", "Rushing touchdowns of 40 or more yards.", "count", 0],
  ["rush_attempts_redzone", "Red Zone Carries", "Carries from inside the opponent 20.", "count", 0],
  ["rush_attempts_inside_5", "Carries Inside the 5", "Carries from inside the opponent 5.", "count", 0],
  ["rush_yards_before_contact", "Yards Before Contact", "Rushing yards gained before first contact.", "count", 0],
  ["rush_yards_after_contact", "Yards After Contact", "Rushing yards gained after first contact.", "count", 0],
  ["rush_broken_tackles", "Broken Tackles", "Tackles broken on rushing plays.", "count", 0],
  ["rush_stuffed", "Runs Stuffed", "Carries stopped at or behind the line.", "count", 0],
  ["rush_100_bonus", "100+ Rushing Yards", "Bonus when a rusher clears 100 yards.", "flag", 0],
  ["rush_150_bonus", "150+ Rushing Yards", "Bonus when a rusher clears 150 yards.", "flag", 0],
  ["rush_200_bonus", "200+ Rushing Yards", "Bonus when a rusher clears 200 yards.", "flag", 0],
  ["rush_3td_bonus", "3+ Rushing TDs", "Bonus for three or more rushing touchdowns.", "flag", 0],
  ["yards_per_carry", "Yards / Carry", "Rushing yards per attempt.", "rate", 0],
  ["rush_yards_over_expected", "Rush Yards Over Expected", "Next Gen Stats RYOE.", "count", 0],
]);

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------
const RECEIVING = group("Receiving", "player", [
  ["targets", "Targets", "Times targeted.", "count", 0],
  ["receptions", "Receptions", "Catches. Set to 1 for full PPR, 0.5 for half.", "count", 1],
  ["receiving_yards", "Receiving Yards", "Net receiving yards.", "count", 0.1],
  ["receiving_tds", "Receiving TDs", "Receiving touchdowns.", "count", 6],
  ["receiving_first_downs", "Receiving First Downs", "First downs gained receiving.", "count", 0],
  ["receiving_air_yards", "Receiving Air Yards", "Air yards on all targets.", "count", 0],
  ["receiving_yards_after_catch", "Receiving YAC", "Yards gained after the catch.", "count", 0],
  ["receiving_epa", "Receiving EPA", "Expected points added receiving. Can be negative.", "count", 0],
  ["rec_2pt_conversions", "2PT Receptions", "Successful two-point conversion catches.", "count", 2],
  ["receiving_fumbles", "Receiving Fumbles", "Fumbles after a catch.", "count", 0],
  ["receiving_fumbles_lost", "Receiving Fumbles Lost", "Receiving fumbles lost to the defense.", "count", 0],
  ["drops", "Drops", "Charted dropped passes.", "count", 0],
  ["rec_20_plus", "Receptions 20+ Yards", "Catches gaining 20 or more yards.", "count", 0],
  ["rec_40_plus", "Receptions 40+ Yards", "Catches gaining 40 or more yards.", "count", 0],
  ["rec_td_40_plus", "Rec TDs 40+ Yards", "Receiving touchdowns of 40 or more yards.", "count", 0],
  ["targets_redzone", "Red Zone Targets", "Targets inside the opponent 20.", "count", 0],
  ["targets_endzone", "End Zone Targets", "Targets thrown into the end zone.", "count", 0],
  ["targets_deep", "Deep Targets", "Targets travelling 20+ air yards.", "count", 0],
  ["rec_100_bonus", "100+ Receiving Yards", "Bonus when a receiver clears 100 yards.", "flag", 0],
  ["rec_150_bonus", "150+ Receiving Yards", "Bonus when a receiver clears 150 yards.", "flag", 0],
  ["rec_200_bonus", "200+ Receiving Yards", "Bonus when a receiver clears 200 yards.", "flag", 0],
  ["rec_10_catch_bonus", "10+ Receptions", "Bonus for ten or more catches.", "flag", 0],
  ["target_share", "Target Share", "Share of the team's targets.", "rate", 0],
  ["air_yards_share", "Air Yards Share", "Share of the team's air yards.", "rate", 0],
  ["wopr", "WOPR", "Weighted opportunity rating.", "rate", 0],
  ["racr", "RACR", "Receiver air conversion ratio.", "rate", 0],
  ["yards_per_reception", "Yards / Reception", "Receiving yards per catch.", "rate", 0],
  ["yards_per_target", "Yards / Target", "Receiving yards per target.", "rate", 0],
]);

// ---------------------------------------------------------------------------
// Kicking
// ---------------------------------------------------------------------------
const KICKING = group("Kicking", "player", [
  ["fg_made", "FG Made", "Field goals made, any distance.", "count", 3],
  ["fg_attempts", "FG Attempts", "Field goals attempted.", "count", 0],
  ["fg_missed", "FG Missed", "Field goals missed.", "count", -1],
  ["fg_made_0_19", "FG Made 0-19", "Made field goals under 20 yards.", "count", 0],
  ["fg_made_20_29", "FG Made 20-29", "Made field goals of 20-29 yards.", "count", 0],
  ["fg_made_30_39", "FG Made 30-39", "Made field goals of 30-39 yards.", "count", 0],
  ["fg_made_40_49", "FG Made 40-49", "Made field goals of 40-49 yards.", "count", 1],
  ["fg_made_50_59", "FG Made 50-59", "Made field goals of 50-59 yards.", "count", 2],
  ["fg_made_60_plus", "FG Made 60+", "Made field goals of 60 or more yards.", "count", 3],
  ["fg_missed_0_39", "FG Missed 0-39", "Missed field goals under 40 yards.", "count", 0],
  ["fg_missed_40_49", "FG Missed 40-49", "Missed field goals of 40-49 yards.", "count", 0],
  ["fg_missed_50_plus", "FG Missed 50+", "Missed field goals of 50 or more yards.", "count", 0],
  ["fg_made_total_yards", "FG Yardage", "Summed distance of every made field goal.", "count", 0],
  ["fg_longest", "Longest FG", "Longest made field goal in the game.", "count", 0],
  ["pat_made", "XP Made", "Extra points made.", "count", 1],
  ["pat_attempts", "XP Attempts", "Extra points attempted.", "count", 0],
  ["pat_missed", "XP Missed", "Extra points missed.", "count", -1],
]);

// ---------------------------------------------------------------------------
// Fumbles & returns (apply to every offensive position)
// ---------------------------------------------------------------------------
const MISC_OFFENSE = group("Fumbles & Returns", "player", [
  ["fumbles", "Fumbles", "All fumbles, lost or not.", "count", 0],
  ["fumbles_lost", "Fumbles Lost", "Fumbles recovered by the opponent.", "count", -2],
  ["fumble_recoveries_own", "Own Fumble Recoveries", "Own fumbles recovered by the player.", "count", 0],
  ["fumble_recovery_tds", "Fumble Recovery TDs", "Touchdowns scored on a fumble recovery.", "count", 6],
  ["kick_returns", "Kick Returns", "Kickoff returns.", "count", 0],
  ["kick_return_yards", "Kick Return Yards", "Yards on kickoff returns.", "count", 0],
  ["kick_return_tds", "Kick Return TDs", "Kickoff returns for a touchdown.", "count", 6],
  ["punt_returns", "Punt Returns", "Punt returns.", "count", 0],
  ["punt_return_yards", "Punt Return Yards", "Yards on punt returns.", "count", 0],
  ["punt_return_tds", "Punt Return TDs", "Punt returns for a touchdown.", "count", 6],
  ["special_teams_tds", "Special Teams TDs", "Kick or punt returns for a touchdown, either kind.", "count", 6],
  ["offensive_snaps", "Offensive Snaps", "Snaps played on offense.", "count", 0],
  ["snap_share", "Snap Share", "Share of the team's offensive snaps.", "rate", 0],
  ["total_touches", "Touches", "Carries plus receptions.", "count", 0],
  ["total_yards_from_scrimmage", "Yards From Scrimmage", "Rushing plus receiving yards.", "count", 0],
  ["all_purpose_yards", "All-Purpose Yards", "Scrimmage yards plus return yards.", "count", 0],
  ["total_tds", "Total TDs", "Every touchdown scored, any method.", "count", 0],
]);

// ---------------------------------------------------------------------------
// IDP -- individual defensive players
// ---------------------------------------------------------------------------
const DEFENSE_IDP = group("Defense (IDP)", "player", [
  ["tackles_solo", "Solo Tackles", "Unassisted tackles.", "count", 0],
  ["tackles_assist", "Assisted Tackles", "Assists on a tackle.", "count", 0],
  ["tackles_combined", "Combined Tackles", "Solo plus assisted tackles.", "count", 0],
  ["tackles_for_loss", "Tackles For Loss", "Tackles behind the line of scrimmage.", "count", 0],
  ["def_sacks", "Sacks", "Sacks recorded. Halves are possible.", "count", 0],
  ["def_sack_yards", "Sack Yards", "Yards lost on the sacks recorded.", "count", 0],
  ["qb_hits", "QB Hits", "Hits on the quarterback.", "count", 0],
  ["def_interceptions", "Interceptions", "Passes intercepted.", "count", 0],
  ["def_interception_yards", "INT Return Yards", "Return yards on interceptions.", "count", 0],
  ["def_interception_tds", "Pick Sixes", "Interceptions returned for a touchdown.", "count", 0],
  ["passes_defended", "Passes Defended", "Passes broken up.", "count", 0],
  ["forced_fumbles", "Forced Fumbles", "Fumbles forced.", "count", 0],
  ["def_fumble_recoveries", "Fumble Recoveries", "Opponent fumbles recovered.", "count", 0],
  ["def_fumble_return_yards", "Fumble Return Yards", "Return yards on recovered fumbles.", "count", 0],
  ["def_fumble_tds", "Fumble Return TDs", "Recovered fumbles returned for a score.", "count", 0],
  ["def_safeties", "Safeties", "Safeties recorded.", "count", 0],
  ["def_blocked_kicks", "Blocked Kicks", "Field goals, punts or XPs blocked.", "count", 0],
  ["def_tds", "Defensive TDs", "Any touchdown scored by the defender.", "count", 0],
  ["defensive_snaps", "Defensive Snaps", "Snaps played on defense.", "count", 0],
  ["def_stuffs", "Run Stuffs", "Ball carriers stopped at or behind the line.", "count", 0],
  ["def_targets", "Targets Allowed", "Times targeted in coverage.", "count", 0],
  ["def_completions_allowed", "Completions Allowed", "Catches allowed in coverage.", "count", 0],
  ["def_yards_allowed", "Coverage Yards Allowed", "Receiving yards allowed in coverage.", "count", 0],
]);

// ---------------------------------------------------------------------------
// Team defense / special teams (the D/ST slot)
// ---------------------------------------------------------------------------
const TEAM_DEFENSE = group("Team Defense / ST", "team_defense", [
  ["dst_sacks", "Sacks", "Team sacks.", "count", 1],
  ["dst_interceptions", "Interceptions", "Team interceptions.", "count", 2],
  ["dst_fumble_recoveries", "Fumble Recoveries", "Opponent fumbles recovered.", "count", 2],
  ["dst_forced_fumbles", "Forced Fumbles", "Fumbles forced by the defense.", "count", 0],
  ["dst_safeties", "Safeties", "Safeties scored.", "count", 2],
  ["dst_tds", "Defensive/ST TDs", "Any defensive or special teams touchdown.", "count", 6],
  ["dst_blocked_kicks", "Blocked Kicks", "Kicks blocked.", "count", 2],
  ["dst_tackles_for_loss", "Tackles For Loss", "Team tackles behind the line.", "count", 0],
  ["dst_qb_hits", "QB Hits", "Team hits on the quarterback.", "count", 0],
  ["dst_passes_defended", "Passes Defended", "Team passes broken up.", "count", 0],
  ["dst_return_yards", "Return Yards", "Kick plus punt return yards.", "count", 0],
  ["dst_return_tds", "Return TDs", "Kick or punt returns for a touchdown.", "count", 0],
  ["dst_points_allowed", "Points Allowed", "Points surrendered. Score this negatively.", "count", 0],
  ["dst_yards_allowed", "Yards Allowed", "Total yards surrendered.", "count", 0],
  ["dst_pass_yards_allowed", "Pass Yards Allowed", "Passing yards surrendered.", "count", 0],
  ["dst_rush_yards_allowed", "Rush Yards Allowed", "Rushing yards surrendered.", "count", 0],
  ["dst_first_downs_allowed", "First Downs Allowed", "First downs surrendered.", "count", 0],
  ["dst_three_and_outs", "Three And Outs", "Opponent drives ending in a punt after three plays.", "count", 0],
  ["dst_fourth_down_stops", "Fourth Down Stops", "Opponent fourth down attempts stopped.", "count", 0],
  ["dst_turnovers", "Total Turnovers", "Interceptions plus fumble recoveries.", "count", 0],
  ["dst_shutout", "Shutout", "Opponent held to zero points.", "flag", 0],
  ["dst_pa_0", "Points Allowed: 0", "Bonus tier when the opponent is shut out.", "flag", 10],
  ["dst_pa_1_6", "Points Allowed: 1-6", "Bonus tier for 1-6 points allowed.", "flag", 7],
  ["dst_pa_7_13", "Points Allowed: 7-13", "Bonus tier for 7-13 points allowed.", "flag", 4],
  ["dst_pa_14_20", "Points Allowed: 14-20", "Bonus tier for 14-20 points allowed.", "flag", 1],
  ["dst_pa_21_27", "Points Allowed: 21-27", "Bonus tier for 21-27 points allowed.", "flag", 0],
  ["dst_pa_28_34", "Points Allowed: 28-34", "Bonus tier for 28-34 points allowed.", "flag", -1],
  ["dst_pa_35_plus", "Points Allowed: 35+", "Bonus tier for 35 or more points allowed.", "flag", -4],
  ["dst_ya_under_100", "Yards Allowed: <100", "Bonus tier for under 100 total yards allowed.", "flag", 0],
  ["dst_ya_100_199", "Yards Allowed: 100-199", "Bonus tier for 100-199 yards allowed.", "flag", 0],
  ["dst_ya_200_299", "Yards Allowed: 200-299", "Bonus tier for 200-299 yards allowed.", "flag", 0],
  ["dst_ya_300_399", "Yards Allowed: 300-399", "Bonus tier for 300-399 yards allowed.", "flag", 0],
  ["dst_ya_400_449", "Yards Allowed: 400-449", "Bonus tier for 400-449 yards allowed.", "flag", 0],
  ["dst_ya_450_plus", "Yards Allowed: 450+", "Bonus tier for 450 or more yards allowed.", "flag", 0],
]);

export const STAT_CATALOG: StatDefinition[] = [
  ...PASSING,
  ...RUSHING,
  ...RECEIVING,
  ...KICKING,
  ...MISC_OFFENSE,
  ...DEFENSE_IDP,
  ...TEAM_DEFENSE,
];

export const STAT_CATEGORIES = Array.from(
  new Set(STAT_CATALOG.map((s) => s.category)),
);

export const STAT_BY_KEY: Record<string, StatDefinition> = Object.fromEntries(
  STAT_CATALOG.map((s) => [s.key, s]),
);

/** Stats a league can actually attach points to. */
export const SCORABLE_STATS = STAT_CATALOG.filter((s) => s.scorable);

/** Stats no feed we ingest carries, so the admin UI can say as much. */
export const UNTRACKED_STATS = STAT_CATALOG.filter((s) => !s.tracked);
