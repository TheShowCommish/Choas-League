/**
 * The shape of a league's playoffs, worked out without a database.
 *
 * The bracket itself is built in SQL (generate_playoffs, advance_playoffs
 * and friends in supabase/migrations). The admin screen needs to show a
 * commissioner what their settings will produce, and the save action
 * needs to refuse settings that cannot work, before any team has played
 * a playoff game. Both use these functions, and scripts/losers-bracket
 * .test.ts runs the same cases through the SQL so the two cannot drift.
 *
 * No imports, so the tests can load it straight from node.
 */

/** The last week of the NFL regular season. Fantasy playoffs end by then. */
export const NFL_LAST_WEEK = 18;

export type BracketKey = "winners" | "losers";

/** Who drops into the losers bracket. */
export type LosersEntrants =
  | "eliminated_playoff_teams"
  | "non_playoff_teams"
  | "both";

/**
 * consolation: winners advance, and the last team standing is the best
 * of the rest. toilet_bowl: losers advance, and the last team standing
 * finishes last.
 */
export type LosersMode = "consolation" | "toilet_bowl";

/**
 * fixed: a team keeps its place in the draw. reseed: every round, the
 * best remaining seed plays the worst.
 */
export type LosersReseed = "fixed" | "reseed";

export interface LosersSettings {
  enabled: boolean;
  entrants: LosersEntrants | null;
  mode: LosersMode | null;
  reseed: LosersReseed | null;
  startWeek: number | null;
}

/**
 * Whether the winners bracket keeps its draw or re-seeds. The same two
 * choices the losers bracket has; see LosersReseed.
 */
export type PlayoffReseed = LosersReseed;

/**
 * What settles a playoff game the two teams finished level on.
 *
 * higher_seed  the top seed of that bracket goes through. In a toilet
 *              bowl the seeding is turned over, so the top seed is the
 *              WORST team -- a draw can never be its way out.
 * bench_points the bigger bench over the matchup's weeks wins the game,
 *              and the bracket decides what winning is worth.
 * points_for   the same, on points for over the season.
 *
 * There is no "split": a round has to send exactly one team on, so a
 * tie that stands is not something a bracket can express (0041).
 */
export type PlayoffTiebreak = "higher_seed" | "bench_points" | "points_for";

/**
 * What separates teams level on wins and losses, applied in the order
 * the league listed them.
 *
 * division_record is accepted and does nothing until divisions exist
 * (T-041); coin_flip is deterministic, not random (see 0041).
 */
export type SeedingTiebreaker =
  | "head_to_head"
  | "points_for"
  | "points_against"
  | "division_record"
  | "coin_flip";

export const SEEDING_TIEBREAKERS: SeedingTiebreaker[] = [
  "head_to_head",
  "points_for",
  "points_against",
  "division_record",
  "coin_flip",
];

/** What a league that has never touched the setting uses. */
export const DEFAULT_SEEDING_TIEBREAKERS: SeedingTiebreaker[] = [
  "head_to_head",
  "points_for",
];

/** The league-wide seeding and tiebreak settings, as one form's worth. */
export interface SeedingSettings {
  /** Applied in order, after wins and losses. */
  tiebreakers: SeedingTiebreaker[];
  winnersReseed: PlayoffReseed;
  winnersTiebreak: PlayoffTiebreak;
  losersTiebreak: PlayoffTiebreak;
}

export const DEFAULT_SEEDING_SETTINGS: SeedingSettings = {
  tiebreakers: DEFAULT_SEEDING_TIEBREAKERS,
  winnersReseed: "fixed",
  winnersTiebreak: "higher_seed",
  losersTiebreak: "higher_seed",
};

/**
 * The settings as they can be saved, or null if anything in them is not
 * one of the choices. Duplicates are dropped, keeping the first place
 * each one appears; an empty list means wins and losses alone.
 *
 * The save action runs this before writing, so a hand-made request
 * cannot put a value in the column the bracket would not understand.
 */
export function cleanSeedingSettings(
  raw: SeedingSettings | null | undefined,
): SeedingSettings | null {
  if (!raw) return null;

  const tiebreakers: SeedingTiebreaker[] = [];
  for (const value of raw.tiebreakers ?? []) {
    if (!SEEDING_TIEBREAKERS.includes(value)) return null;
    if (!tiebreakers.includes(value)) tiebreakers.push(value);
  }

  const reseed: PlayoffReseed[] = ["fixed", "reseed"];
  const tiebreak: PlayoffTiebreak[] = [
    "higher_seed",
    "bench_points",
    "points_for",
  ];
  if (!reseed.includes(raw.winnersReseed)) return null;
  if (!tiebreak.includes(raw.winnersTiebreak)) return null;
  if (!tiebreak.includes(raw.losersTiebreak)) return null;

  return {
    tiebreakers,
    winnersReseed: raw.winnersReseed,
    winnersTiebreak: raw.winnersTiebreak,
    losersTiebreak: raw.losersTiebreak,
  };
}

/**
 * Which side of a playoff game goes through, mirroring
 * playoff_game_advancer in 0041 so the tests can hold the two against
 * each other.
 *
 * `losersAdvance` is the bracket's rule, not the game's. `homeKey` and
 * `awayKey` are the tiebreak's measure of each side (bench points,
 * points for), higher being better, and are read only when the scores
 * are level. `homeSeed` and `awaySeed` are the two teams' seeds in this
 * bracket, which a fixed draw does not keep in the same order as the
 * home and away sides: the winner of 1v8 is at home against the winner
 * of 4v5 holding the worse seed of the two.
 */
export function playoffAdvancer({
  homeScore,
  awayScore,
  hasAway = true,
  losersAdvance = false,
  tiebreak = "higher_seed",
  homeKey = 0,
  awayKey = 0,
  homeSeed = null,
  awaySeed = null,
}: {
  homeScore: number;
  awayScore: number;
  hasAway?: boolean;
  losersAdvance?: boolean;
  tiebreak?: PlayoffTiebreak;
  homeKey?: number;
  awayKey?: number;
  homeSeed?: number | null;
  awaySeed?: number | null;
}): "home" | "away" {
  if (!hasAway) return "home";
  if (homeScore > awayScore) return losersAdvance ? "away" : "home";
  if (awayScore > homeScore) return losersAdvance ? "home" : "away";
  if (tiebreak !== "higher_seed" && homeKey !== awayKey) {
    return (homeKey > awayKey) !== losersAdvance ? "home" : "away";
  }
  // higher_seed, or level on the tiebreak too: the better seed of this
  // bracket goes through. A toilet bowl seeds the worst record first,
  // so its better seed is the worse team and it keeps sinking.
  if (homeSeed !== null && awaySeed !== null && homeSeed !== awaySeed) {
    return homeSeed < awaySeed ? "home" : "away";
  }
  // No seeds to compare, which only happens to a bracket built before
  // they were written: the home side falls back in.
  return "home";
}

/** One configured round, as stored in league_playoff_rounds. */
export interface RoundConfig {
  name: string;
  weeks: number;
  /** How many teams contest the round. Null = everybody still standing. */
  teams: number | null;
  /** How many of those, top seeds first, sit it out. */
  byes: number;
}

/** What a round will actually look like once it is played. */
export interface RoundShape {
  /** 1-based. */
  index: number;
  from: number;
  to: number;
  /** Teams in the round, byes included. */
  field: number;
  byes: number;
  games: number;
  /** Teams that go on to the next round. */
  advancing: number;
}

export const LOSERS_ENTRANTS_LABELS: Record<LosersEntrants, string> = {
  eliminated_playoff_teams: "Teams knocked out of the playoffs",
  non_playoff_teams: "Teams that missed the playoffs",
  both: "Both",
};

export const LOSERS_MODE_LABELS: Record<LosersMode, string> = {
  consolation: "Consolation (winners advance)",
  toilet_bowl: "Toilet bowl (losers advance)",
};

export const LOSERS_RESEED_LABELS: Record<LosersReseed, string> = {
  fixed: "Fixed bracket",
  reseed: "Re-seed every round",
};

/**
 * The byes a round will really get, mirroring playoff_round_byes in the
 * database so the preview and the bracket cannot disagree.
 *
 * The field left playing has to be even. A request that would leave it
 * odd is nudged up, because a bye promised to a top seed is worse to
 * take away than to hand out spare -- unless nudging up would put the
 * whole field on a bye and leave the round with no games at all.
 */
export function settleByes(field: number, requested: number): number {
  if (field <= 1) return 0;

  const capped = Math.min(Math.max(requested, 0), field - 1);
  if ((field - capped) % 2 === 0) return capped;
  if (capped + 1 < field) return capped + 1;
  return Math.max(capped - 1, 0);
}

/**
 * The weeks each round occupies, laid end to end from `startWeek`.
 * Mirrors playoff_round_start / playoff_round_weeks.
 */
export function roundSpans(
  startWeek: number,
  rounds: { weeks: number }[],
): { from: number; to: number }[] {
  const spans: { from: number; to: number }[] = [];
  let week = startWeek;
  for (const round of rounds) {
    spans.push({ from: week, to: week + round.weeks - 1 });
    week += round.weeks;
  }
  return spans;
}

function nextPowerOfTwo(n: number): number {
  let p = 2;
  while (p < n) p *= 2;
  return p;
}

/**
 * Plays a bracket out on paper, the way the database will.
 *
 * `firstRoundByes` is the byes requested for round one; later rounds
 * take theirs from the configuration. A round with a smaller field than
 * the teams left trims the lowest seeds. Rounds past the configured ones
 * last a week, with no byes, as advance_playoffs does. `configuredOnly`
 * stops at the last configured round instead of playing to one team.
 */
function playOut(
  startWeek: number,
  entrants: number,
  rounds: RoundConfig[],
  firstRoundByes: number,
  configuredOnly: boolean,
): RoundShape[] {
  const shape: RoundShape[] = [];
  let field = entrants;
  let week = startWeek;

  // 64 rounds is far past any bracket that fits in a season; it only
  // guards against a loop that would otherwise never end.
  for (let index = 1; field >= 2 && index <= 64; index++) {
    const cfg = rounds[index - 1];
    if (!cfg && configuredOnly) break;

    if (index > 1 && cfg?.teams != null && cfg.teams < field) {
      field = cfg.teams;
    }

    const byes = settleByes(
      field,
      index === 1 ? firstRoundByes : (cfg?.byes ?? 0),
    );
    const games = (field - byes) / 2;
    const weeks = cfg?.weeks ?? 1;

    shape.push({
      index,
      from: week,
      to: week + weeks - 1,
      field,
      byes,
      games,
      advancing: byes + games,
    });

    week += weeks;
    field = byes + games;
  }

  return shape;
}

/**
 * The winners bracket, as generate_playoffs and advance_playoffs build it.
 *
 * With no rounds configured the database seeds one-week rounds until one
 * team is left, and round one hands out whatever byes it takes to reach
 * a power of two. So does this.
 */
export function winnersShape({
  playoffStartWeek,
  playoffTeams,
  teamCount,
  rounds,
}: {
  playoffStartWeek: number;
  playoffTeams: number;
  teamCount: number;
  rounds: RoundConfig[];
}): RoundShape[] {
  let field = Math.min(playoffTeams, teamCount);
  const first = rounds[0];
  if (first?.teams != null) field = Math.min(field, first.teams);
  if (field < 2) return [];

  const byes = !first || first.byes === 0
    ? nextPowerOfTwo(field) - field
    : first.byes;

  return playOut(playoffStartWeek, field, rounds, byes, false);
}

/**
 * How many teams the losers bracket will start with, or why it cannot
 * be worked out.
 *
 * Teams knocked out of the playoffs are the ones no longer in the
 * winners bracket by the losers bracket's first week. A start week in
 * the middle of a multi-week winners round is refused: the teams going
 * out of that round are not known until it ends, which is after the
 * losers bracket was meant to have started.
 */
export function losersEntrantCount(
  settings: LosersSettings,
  winners: RoundShape[],
  teamCount: number,
): { count: number } | { error: string } {
  const start = settings.startWeek;
  if (!settings.entrants || start == null) {
    return { error: "Choose who enters the losers bracket and when it starts." };
  }

  const playoffField = winners[0]?.field ?? 0;
  let count = 0;

  if (settings.entrants !== "eliminated_playoff_teams") {
    count += Math.max(teamCount - playoffField, 0);
  }

  if (settings.entrants !== "non_playoff_teams" && winners.length > 0) {
    const midRound = winners.find((r) => r.from < start && start <= r.to);
    if (midRound) {
      return {
        error: `The losers bracket starts in week ${start}, in the middle of winners round ${midRound.index} (weeks ${midRound.from}-${midRound.to}). Start it when a winners round starts or after the final.`,
      };
    }

    const alive = winners.find((r) => r.from >= start);
    count += alive ? playoffField - alive.field : playoffField - 1;
  }

  return { count };
}

/** The losers bracket, as start_losers_bracket and advance_playoffs build it. */
export function losersShape(
  startWeek: number,
  entrants: number,
  rounds: RoundConfig[],
  configuredOnly = false,
): RoundShape[] {
  const first = rounds[0];
  const field =
    first?.teams != null ? Math.min(entrants, first.teams) : entrants;
  if (field < 2) return [];
  return playOut(startWeek, field, rounds, first?.byes ?? 0, configuredOnly);
}

/**
 * Everything wrong with a losers bracket configuration, in the order a
 * commissioner would fix it. Empty when it will work.
 *
 * Nothing is checked while the bracket is switched off, so a commissioner
 * can park a half-finished setup.
 */
export function validateLosersBracket({
  settings,
  rounds,
  playoffStartWeek,
  playoffTeams,
  teamCount,
  winnersRounds,
}: {
  settings: LosersSettings;
  rounds: RoundConfig[];
  playoffStartWeek: number;
  playoffTeams: number;
  teamCount: number;
  winnersRounds: RoundConfig[];
}): string[] {
  if (!settings.enabled) return [];

  const errors: string[] = [];
  if (!settings.entrants) errors.push("Choose who enters the losers bracket.");
  if (!settings.mode) errors.push("Choose whether winners or losers advance.");
  if (!settings.reseed) errors.push("Choose a fixed bracket or re-seeding.");
  if (settings.startWeek == null || !Number.isInteger(settings.startWeek)) {
    errors.push("Choose the week the losers bracket starts.");
  }
  if (errors.length > 0) return errors;

  const start = settings.startWeek!;
  if (start < playoffStartWeek) {
    errors.push(
      `The losers bracket can't start before the playoffs (week ${playoffStartWeek}).`,
    );
  }
  if (rounds.length === 0) {
    errors.push("Add at least one losers bracket round.");
    return errors;
  }

  const winners = winnersShape({
    playoffStartWeek,
    playoffTeams,
    teamCount,
    rounds: winnersRounds,
  });
  const entrants = losersEntrantCount(settings, winners, teamCount);
  if ("error" in entrants) {
    errors.push(entrants.error);
    return errors;
  }

  if (entrants.count < 2) {
    errors.push(
      `Only ${entrants.count} team${entrants.count === 1 ? "" : "s"} would enter the losers bracket. It needs at least two.`,
    );
    return errors;
  }

  const first = rounds[0];
  if (first.teams != null && first.teams !== entrants.count) {
    errors.push(
      `Round 1 is set for ${first.teams} teams, but ${entrants.count} enter the losers bracket.`,
    );
  }

  // Round by round, over the configured rounds only.
  let field = first.teams ?? entrants.count;
  for (let i = 0; i < rounds.length; i++) {
    const cfg = rounds[i];
    if (field < 2) {
      errors.push(`Round ${i + 1} has nobody left to play. Remove it.`);
      break;
    }
    if (i > 0 && cfg.teams != null) {
      // A fixed draw pairs by place in the bracket, so there is no
      // "lowest seed" to drop -- the database would cut by draw slot.
      if (settings.reseed === "fixed" && cfg.teams < field) {
        errors.push(
          `A fixed bracket can't drop teams after round 1. Leave round ${i + 1}'s teams blank or re-seed.`,
        );
      } else if (cfg.teams > field) {
        errors.push(
          `Round ${i + 1} is set for ${cfg.teams} teams, but only ${field} are left.`,
        );
      } else {
        field = cfg.teams;
      }
    }
    const byes = settleByes(field, cfg.byes);
    field = byes + (field - byes) / 2;
  }

  if (field > 1 && errors.length === 0) {
    errors.push(
      `The losers bracket rounds end with ${field} teams still standing. Add rounds until one is left.`,
    );
  }

  const spans = roundSpans(start, rounds);
  const last = spans[spans.length - 1];
  if (last.to > NFL_LAST_WEEK) {
    errors.push(
      `The losers bracket runs to week ${last.to}, past the end of the NFL season (week ${NFL_LAST_WEEK}).`,
    );
  }

  return errors;
}
