/**
 * Average draft position, from real mock drafts.
 *
 * Fantasy Football Calculator runs public mock drafts all summer and
 * publishes the resulting ADP as plain JSON. That is a different and
 * better number than the one the draft board had before: ESPN reports a
 * placeholder outside its own drafting season, and its editorial draft
 * rank is one analyst's opinion rather than what a room full of people
 * actually did. This is thousands of drafts, refreshed daily, and it
 * moves the moment somebody gets hurt in camp.
 *
 * Unofficial and undocumented like every other feed here, so treat
 * every field as optional and let a bad response fall through to ESPN
 * rather than leaving the board with no order at all.
 */

import {
  matchName,
  PlayerIndex,
  type MatchablePlayer,
} from "./player-match.ts";

// Re-exported because this module used to own them, and the ADP tests
// and the ingest jobs both still reach for them here.
export { matchName, type MatchablePlayer };

const ADP_API = "https://fantasyfootballcalculator.com/api/v1/adp";

/** Which draft format the ADP was averaged over. */
export type MockScoring = "ppr" | "half-ppr" | "standard" | "2qb" | "dynasty";

export interface MockAdpEntry {
  /** As the mock drafts spell it, before any normalising. */
  name: string;
  /** Normalised for matching: lowercase, no punctuation, no suffix. */
  matchName: string;
  /** Our position vocabulary, so PK has already become K. */
  position: string | null;
  /** nflverse team abbreviation, or null. */
  team: string | null;
  /** The value stored as ADP. Lower is earlier. */
  adp: number;
  /** Position in this list once sorted, 1-based. */
  rank: number;
  /** How many drafts the average is over. */
  timesDrafted: number;
}

export interface MockAdpResult {
  entries: MockAdpEntry[];
  /** How many mock drafts the whole set is averaged over. */
  totalDrafts: number;
  scoring: MockScoring;
  teams: number;
}

interface FfcPlayer {
  name?: string;
  position?: string;
  team?: string;
  adp?: number;
  times_drafted?: number;
}

interface FfcResponse {
  status?: string;
  meta?: { total_drafts?: number };
  players?: FfcPlayer[];
}

/** Their position vocabulary is nearly ours. PK is the exception. */
const POSITIONS: Record<string, string> = {
  QB: "QB",
  RB: "RB",
  WR: "WR",
  TE: "TE",
  PK: "K",
  K: "K",
  DEF: "DEF",
  DST: "DEF",
};

/** Their team abbreviations, where they differ from nflverse's. */
const TEAM_ALIASES: Record<string, string> = {
  JAC: "JAX",
  LAR: "LA",
  WSH: "WAS",
  OAK: "LV",
  SD: "LAC",
  STL: "LA",
};

/**
 * Renumbers a set of entries by the ADP actually stored, so `rank` and
 * `adp` can never disagree.
 */
function renumber(entries: MockAdpEntry[]): MockAdpEntry[] {
  entries.sort((a, b) => a.adp - b.adp);
  entries.forEach((entry, index) => {
    entry.rank = index + 1;
  });
  return entries;
}

/**
 * Turns one FFC payload into entries, dropping anything unusable.
 *
 * Exported for the tests, which would otherwise have to reach the
 * network to check the parsing.
 */
export function parseMockAdp(
  body: FfcResponse,
  scoring: MockScoring,
  teams: number,
): MockAdpResult {
  const entries: MockAdpEntry[] = [];

  for (const row of body.players ?? []) {
    const name = row.name?.trim();
    const adp = Number(row.adp);
    if (!name || !Number.isFinite(adp) || adp <= 0) continue;

    const position = row.position
      ? (POSITIONS[row.position.toUpperCase()] ?? null)
      : null;

    const rawTeam = row.team?.trim().toUpperCase() ?? "";
    const team = rawTeam ? (TEAM_ALIASES[rawTeam] ?? rawTeam) : null;

    entries.push({
      name,
      matchName: matchName(name),
      position,
      team,
      adp: Math.round(adp * 100) / 100,
      rank: 0,
      timesDrafted: Number(row.times_drafted) || 0,
    });
  }

  return {
    entries: renumber(entries),
    totalDrafts: Number(body.meta?.total_drafts) || 0,
    scoring,
    teams,
  };
}

/**
 * The mock-draft ADP for one season.
 *
 * `teams` and `scoring` pick which pool of drafts to average: a
 * twelve-team PPR board is the common case and the default.
 */
export async function fetchMockDraftAdp(
  season: number,
  { teams = 12, scoring = "ppr" as MockScoring } = {},
): Promise<MockAdpResult> {
  const response = await fetch(
    `${ADP_API}/${scoring}?teams=${teams}&year=${season}&position=all`,
    {
      headers: { "User-Agent": "chaos-league", accept: "application/json" },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new Error(`Fantasy Football Calculator ADP ${response.status}`);
  }

  const body = (await response.json()) as FfcResponse;

  // Their "no drafts for that season yet" answer is a 200 with an error
  // status and no players, which is not an outage and not an ADP either.
  if (body.status && body.status.toLowerCase() !== "success") {
    throw new Error(`Fantasy Football Calculator: ${body.status}`);
  }

  return parseMockAdp(body, scoring, teams);
}

export interface MatchedAdp {
  id: string;
  adp: number;
  adp_rank: number;
  adp_source: string;
}

/**
 * Attaches mock-draft ADP to our own player ids.
 *
 * Matching is by name, because that is all a mock draft records. Name
 * alone is not enough -- there are two Michael Carters and two Josh
 * Allens, playing different positions -- so the position has to agree
 * too, and the NFL team breaks any remaining tie. A defense carries no
 * name we would recognise, so it is matched to its DST_<abbr>
 * pseudo-player by team alone.
 *
 * Anybody who cannot be matched is counted rather than guessed at: a
 * wrong match puts somebody else's ADP on a player, which is worse on a
 * draft board than no ADP at all.
 */
export function matchMockAdp(
  result: MockAdpResult,
  players: MatchablePlayer[],
): { rows: MatchedAdp[]; unmatched: string[] } {
  const index = new PlayerIndex(players);

  const rows: MatchedAdp[] = [];
  const unmatched: string[] = [];
  const seen = new Set<string>();
  const source = `mock-${result.scoring}`;

  for (const entry of result.entries) {
    // A defense carries no name we would recognise -- "Seattle Defense"
    // is not what nflverse calls anything -- so it is matched to its
    // DST_<abbr> pseudo-player by team alone.
    const id =
      entry.position === "DEF"
        ? entry.team
          ? `DST_${entry.team}`
          : null
        : index.find(entry.name, entry.position, entry.team);

    if (!id) {
      unmatched.push(entry.name);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);

    rows.push({
      id,
      adp: entry.adp,
      adp_rank: entry.rank,
      adp_source: source,
    });
  }

  return { rows, unmatched };
}
