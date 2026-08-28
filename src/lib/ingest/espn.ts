/**
 * ESPN's public scoreboard and box score endpoints.
 *
 * These are what make live Sunday scoring possible: nflverse publishes
 * the authoritative numbers hours after a game, which is right for the
 * record but useless while you are watching. ESPN carries a narrower
 * stat set that updates within a minute or so of each play.
 *
 * Anything ingested from here is written with source = 'live'. The
 * nflverse job later overwrites it with source = 'final', and never the
 * other way round -- see syncLiveScores.
 *
 * Undocumented endpoints, so treat every field as optional.
 */

import type { StatMap } from "./map-stats.ts";

const SCOREBOARD =
  "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const SUMMARY =
  "https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary";

export interface EspnGame {
  eventId: string;
  /** 'pre' | 'in' | 'post' */
  state: string;
  completed: boolean;
  week: number;
  homeAbbr: string;
  awayAbbr: string;
  homeScore: number;
  awayScore: number;
}

interface ScoreboardResponse {
  week?: { number?: number };
  events?: {
    id: string;
    status?: { type?: { state?: string; completed?: boolean } };
    competitions?: {
      competitors?: {
        homeAway?: string;
        score?: string;
        team?: { abbreviation?: string };
      }[];
    }[];
  }[];
}

/** yyyymmdd, which is the only date format the scoreboard accepts. */
export function espnDate(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

export async function fetchScoreboard(date: Date): Promise<EspnGame[]> {
  const response = await fetch(`${SCOREBOARD}?dates=${espnDate(date)}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`ESPN scoreboard ${response.status}`);
  }

  const data = (await response.json()) as ScoreboardResponse;
  const games: EspnGame[] = [];

  for (const event of data.events ?? []) {
    const competition = event.competitions?.[0];
    const competitors = competition?.competitors ?? [];

    const home = competitors.find((c) => c.homeAway === "home");
    const away = competitors.find((c) => c.homeAway === "away");
    if (!home?.team?.abbreviation || !away?.team?.abbreviation) continue;

    games.push({
      eventId: event.id,
      state: event.status?.type?.state ?? "pre",
      completed: event.status?.type?.completed ?? false,
      week: data.week?.number ?? 0,
      homeAbbr: home.team.abbreviation,
      awayAbbr: away.team.abbreviation,
      homeScore: Number(home.score ?? 0),
      awayScore: Number(away.score ?? 0),
    });
  }

  return games;
}

export interface EspnBoxScore {
  /** ESPN athlete id -> the stats we could map. */
  players: Map<string, StatMap>;
  /** Team abbreviation -> its D/ST line. */
  defenses: Map<string, StatMap>;
}

interface SummaryResponse {
  boxscore?: {
    players?: {
      team?: { abbreviation?: string };
      statistics?: {
        name?: string;
        keys?: string[];
        athletes?: {
          athlete?: { id?: string };
          stats?: string[];
        }[];
      }[];
    }[];
    teams?: {
      team?: { abbreviation?: string };
      statistics?: { name?: string; displayValue?: string }[];
    }[];
  };
  header?: {
    competitions?: {
      competitors?: {
        homeAway?: string;
        score?: string;
        team?: { abbreviation?: string };
      }[];
    }[];
  };
}

const num = (value: string | undefined): number => {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** ESPN packs some pairs into one cell, e.g. "24/42" or "1-10". */
function pair(value: string | undefined, separator: string): [number, number] {
  if (!value) return [0, 0];
  const [a, b] = value.split(separator);
  return [num(a), num(b)];
}

/**
 * Maps one ESPN category's row for one athlete onto catalog keys.
 *
 * Only the stats ESPN actually publishes live -- roughly the box score.
 * The deeper stats (air yards, EPA, YAC) arrive with nflverse later.
 */
function mapCategory(
  category: string,
  keys: string[],
  stats: string[],
): StatMap {
  const get = (key: string) => stats[keys.indexOf(key)];
  const out: StatMap = {};

  switch (category) {
    case "passing": {
      const [completions, attempts] = pair(
        get("completions/passingAttempts"),
        "/",
      );
      const [sacks, sackYards] = pair(get("sacks-sackYardsLost"), "-");
      const yards = num(get("passingYards"));
      const tds = num(get("passingTouchdowns"));

      out.pass_completions = completions;
      out.pass_attempts = attempts;
      out.pass_incompletions = Math.max(0, attempts - completions);
      out.passing_yards = yards;
      out.passing_tds = tds;
      out.interceptions_thrown = num(get("interceptions"));
      out.sacks_taken = sacks;
      out.sack_yards_lost = sackYards;
      out.completion_pct = attempts ? (completions / attempts) * 100 : 0;
      out.yards_per_attempt = attempts ? yards / attempts : 0;

      out.pass_300_bonus = yards >= 300 ? 1 : 0;
      out.pass_400_bonus = yards >= 400 ? 1 : 0;
      out.pass_500_bonus = yards >= 500 ? 1 : 0;
      out.pass_4td_bonus = tds >= 4 ? 1 : 0;
      out.pass_6td_bonus = tds >= 6 ? 1 : 0;
      break;
    }

    case "rushing": {
      const attempts = num(get("rushingAttempts"));
      const yards = num(get("rushingYards"));
      const tds = num(get("rushingTouchdowns"));

      out.rush_attempts = attempts;
      out.rushing_yards = yards;
      out.rushing_tds = tds;
      out.yards_per_carry = attempts ? yards / attempts : 0;
      out.rush_100_bonus = yards >= 100 ? 1 : 0;
      out.rush_150_bonus = yards >= 150 ? 1 : 0;
      out.rush_200_bonus = yards >= 200 ? 1 : 0;
      out.rush_3td_bonus = tds >= 3 ? 1 : 0;
      break;
    }

    case "receiving": {
      const receptions = num(get("receptions"));
      const yards = num(get("receivingYards"));
      const targets = num(get("receivingTargets"));

      out.receptions = receptions;
      out.receiving_yards = yards;
      out.receiving_tds = num(get("receivingTouchdowns"));
      out.targets = targets;
      out.yards_per_reception = receptions ? yards / receptions : 0;
      out.yards_per_target = targets ? yards / targets : 0;
      out.rec_100_bonus = yards >= 100 ? 1 : 0;
      out.rec_150_bonus = yards >= 150 ? 1 : 0;
      out.rec_200_bonus = yards >= 200 ? 1 : 0;
      out.rec_10_catch_bonus = receptions >= 10 ? 1 : 0;
      break;
    }

    case "fumbles":
      out.fumbles = num(get("fumbles"));
      out.fumbles_lost = num(get("fumblesLost"));
      out.fumble_recoveries_own = num(get("fumblesRecovered"));
      break;

    case "defensive":
      out.tackles_combined = num(get("totalTackles"));
      out.tackles_solo = num(get("soloTackles"));
      out.tackles_assist = Math.max(
        0,
        num(get("totalTackles")) - num(get("soloTackles")),
      );
      out.def_sacks = num(get("sacks"));
      out.tackles_for_loss = num(get("tacklesForLoss"));
      out.passes_defended = num(get("passesDefended"));
      out.qb_hits = num(get("QBHits"));
      out.def_tds = num(get("defensiveTouchdowns"));
      break;

    case "interceptions":
      out.def_interceptions = num(get("interceptions"));
      out.def_interception_yards = num(get("interceptionYards"));
      out.def_interception_tds = num(get("interceptionTouchdowns"));
      break;

    case "kickReturns":
      out.kick_returns = num(get("kickReturns"));
      out.kick_return_yards = num(get("kickReturnYards"));
      out.special_teams_tds =
        (out.special_teams_tds ?? 0) + num(get("kickReturnTouchdowns"));
      break;

    case "puntReturns":
      out.punt_returns = num(get("puntReturns"));
      out.punt_return_yards = num(get("puntReturnYards"));
      out.special_teams_tds =
        (out.special_teams_tds ?? 0) + num(get("puntReturnTouchdowns"));
      break;

    case "kicking": {
      const [made, attempted] = pair(
        get("fieldGoalsMade/fieldGoalAttempts"),
        "/",
      );
      const [patMade, patAttempted] = pair(
        get("extraPointsMade/extraPointAttempts"),
        "/",
      );

      out.fg_made = made;
      out.fg_attempts = attempted;
      out.fg_missed = Math.max(0, attempted - made);
      out.fg_longest = num(get("longFieldGoalMade"));
      out.pat_made = patMade;
      out.pat_attempts = patAttempted;
      out.pat_missed = Math.max(0, patAttempted - patMade);
      break;
    }
  }

  return out;
}

/** Adds b into a, summing where both have the same key. */
function merge(a: StatMap, b: StatMap): StatMap {
  for (const [key, value] of Object.entries(b)) {
    a[key] = (a[key] ?? 0) + value;
  }
  return a;
}

/** Drop zeroes, matching what the nflverse mapper stores. */
function compact(stats: StatMap): StatMap {
  const out: StatMap = {};
  for (const [key, value] of Object.entries(stats)) {
    if (!Number.isFinite(value)) continue;
    const rounded = Math.round(value * 100) / 100;
    if (rounded === 0) continue;
    out[key] = rounded;
  }
  return out;
}

export async function fetchBoxScore(eventId: string): Promise<EspnBoxScore> {
  const response = await fetch(`${SUMMARY}?event=${eventId}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`ESPN summary ${response.status} for event ${eventId}`);
  }

  const data = (await response.json()) as SummaryResponse;
  const players = new Map<string, StatMap>();

  for (const teamBlock of data.boxscore?.players ?? []) {
    for (const category of teamBlock.statistics ?? []) {
      const name = category.name;
      const keys = category.keys;
      if (!name || !keys) continue;

      for (const athlete of category.athletes ?? []) {
        const id = athlete.athlete?.id;
        if (!id || !athlete.stats) continue;

        const mapped = mapCategory(name, keys, athlete.stats);
        players.set(id, merge(players.get(id) ?? {}, mapped));
      }
    }
  }

  for (const [id, stats] of players) {
    // Totals that need the whole line, so they wait until now.
    const scrimmage =
      (stats.rushing_yards ?? 0) + (stats.receiving_yards ?? 0);
    stats.total_yards_from_scrimmage = scrimmage;
    stats.total_touches = (stats.rush_attempts ?? 0) + (stats.receptions ?? 0);
    stats.all_purpose_yards =
      scrimmage + (stats.kick_return_yards ?? 0) + (stats.punt_return_yards ?? 0);
    stats.total_tds =
      (stats.rushing_tds ?? 0) +
      (stats.receiving_tds ?? 0) +
      (stats.special_teams_tds ?? 0) +
      (stats.def_tds ?? 0);

    players.set(id, compact(stats));
  }

  return { players, defenses: buildDefenses(data) };
}

/** Team D/ST lines, from the team totals plus the score. */
function buildDefenses(data: SummaryResponse): Map<string, StatMap> {
  const defenses = new Map<string, StatMap>();

  const competitors = data.header?.competitions?.[0]?.competitors ?? [];
  const scoreByTeam = new Map<string, number>();
  for (const competitor of competitors) {
    const abbr = competitor.team?.abbreviation;
    if (abbr) scoreByTeam.set(abbr, Number(competitor.score ?? 0));
  }

  const teamBlocks = data.boxscore?.teams ?? [];
  if (teamBlocks.length !== 2) return defenses;

  const stat = (
    block: (typeof teamBlocks)[number],
    name: string,
  ): string | undefined =>
    block.statistics?.find((s) => s.name === name)?.displayValue;

  for (let i = 0; i < 2; i++) {
    const self = teamBlocks[i];
    const other = teamBlocks[1 - i];

    const abbr = self.team?.abbreviation;
    const opponentAbbr = other.team?.abbreviation;
    if (!abbr || !opponentAbbr) continue;

    // The defense's numbers are the opponent's offensive output.
    const pointsAllowed = scoreByTeam.get(opponentAbbr);
    if (pointsAllowed === undefined) continue;

    const passYards = num(stat(other, "netPassingYards"));
    const rushYards = num(stat(other, "rushingYards"));
    const totalYards = num(stat(other, "totalYards")) || passYards + rushYards;
    const [sacks] = pair(stat(other, "sacksYardsLost"), "-");

    const interceptions = num(stat(other, "interceptions"));
    const fumblesLost = num(stat(other, "fumblesLost"));

    defenses.set(
      abbr,
      compact({
        dst_sacks: sacks,
        dst_interceptions: interceptions,
        dst_fumble_recoveries: fumblesLost,
        dst_turnovers: interceptions + fumblesLost,
        dst_tds: num(stat(self, "defensiveTouchdowns")),
        dst_points_allowed: pointsAllowed,
        dst_yards_allowed: totalYards,
        dst_pass_yards_allowed: passYards,
        dst_rush_yards_allowed: rushYards,
        dst_first_downs_allowed: num(stat(other, "firstDowns")),

        dst_shutout: pointsAllowed === 0 ? 1 : 0,
        dst_pa_0: pointsAllowed === 0 ? 1 : 0,
        dst_pa_1_6: pointsAllowed >= 1 && pointsAllowed <= 6 ? 1 : 0,
        dst_pa_7_13: pointsAllowed >= 7 && pointsAllowed <= 13 ? 1 : 0,
        dst_pa_14_20: pointsAllowed >= 14 && pointsAllowed <= 20 ? 1 : 0,
        dst_pa_21_27: pointsAllowed >= 21 && pointsAllowed <= 27 ? 1 : 0,
        dst_pa_28_34: pointsAllowed >= 28 && pointsAllowed <= 34 ? 1 : 0,
        dst_pa_35_plus: pointsAllowed >= 35 ? 1 : 0,

        dst_ya_under_100: totalYards < 100 ? 1 : 0,
        dst_ya_100_199: totalYards >= 100 && totalYards <= 199 ? 1 : 0,
        dst_ya_200_299: totalYards >= 200 && totalYards <= 299 ? 1 : 0,
        dst_ya_300_399: totalYards >= 300 && totalYards <= 399 ? 1 : 0,
        dst_ya_400_449: totalYards >= 400 && totalYards <= 449 ? 1 : 0,
        dst_ya_450_plus: totalYards >= 450 ? 1 : 0,
      }),
    );
  }

  return defenses;
}
