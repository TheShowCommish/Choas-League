import "server-only";

import type { PlayerIndex } from "./player-match.ts";

/**
 * Sleeper: weekly projections, and the id mapping that makes them usable.
 *
 * Sleeper is the only free feed that publishes a projected *stat line*
 * rather than a single points number. That matters, because a points
 * number is projected under somebody else's scoring rules and is
 * meaningless in a league that pays 50 points for a quarterback's
 * tackle. Storing the stat line lets the projection be scored with the
 * league's own rules, through exactly the same engine that scores a real
 * game.
 *
 * The API is undocumented and unofficial. Everything here treats a
 * missing field as absent rather than assuming a shape, so a change at
 * their end degrades to "no projection" instead of a broken page.
 */

/** Sleeper's projected stat keys, mapped onto our catalog. */
const STAT_KEYS: Record<string, string> = {
  // Passing
  pass_att: "pass_attempts",
  pass_cmp: "pass_completions",
  pass_inc: "pass_incompletions",
  pass_yd: "passing_yards",
  pass_td: "passing_tds",
  pass_int: "interceptions_thrown",
  pass_sack: "sacks_taken",
  pass_fd: "passing_first_downs",
  pass_2pt: "pass_2pt_conversions",

  // Rushing
  rush_att: "rush_attempts",
  rush_yd: "rushing_yards",
  rush_td: "rushing_tds",
  rush_fd: "rushing_first_downs",
  rush_2pt: "rush_2pt_conversions",

  // Receiving
  rec: "receptions",
  rec_tgt: "targets",
  rec_yd: "receiving_yards",
  rec_td: "receiving_tds",
  rec_fd: "receiving_first_downs",
  rec_2pt: "rec_2pt_conversions",

  // Everything else
  fum_lost: "fumbles_lost",
  fgm: "fg_made",
  fga: "fg_attempts",
  xpm: "pat_made",
  xpa: "pat_attempts",
};

export interface SleeperProjection {
  /** Our gsis id, not Sleeper's. */
  playerId: string;
  stats: Record<string, number>;
  opponent: string | null;
  injuryStatus: string | null;
}

interface SleeperPlayer {
  player_id?: string;
  gsis_id?: string | null;
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  position?: string | null;
  team?: string | null;
  injury_status?: string | null;
  injury_body_part?: string | null;
  injury_notes?: string | null;
  injury_start_date?: string | null;
  practice_participation?: string | null;
}

interface SleeperProjectionRow {
  player_id?: string;
  stats?: Record<string, unknown>;
  opponent?: string | null;
  player?: { injury_status?: string | null } | null;
}

/**
 * Sleeper's player dump, as rows rather than a blob.
 *
 * ~12,000 players, of whom about 4,000 have ever appeared in a game.
 * The rest are college and practice-squad entries we have no use for,
 * but they cannot be filtered here: the only field that used to tell
 * them apart was gsis_id, and that is exactly the field that has gone
 * unreliable. The matcher sorts it out instead -- somebody who has
 * never played is somebody nflverse has never heard of, so he matches
 * nothing and falls out on his own.
 */
export interface SleeperPlayerRow {
  sleeperId: string;
  /** Our own primary key, when Sleeper still bothers to publish it. */
  gsisId: string | null;
  fullName: string;
  position: string | null;
  team: string | null;
  injuryStatus: string | null;
  injuryBodyPart: string | null;
  injuryNotes: string | null;
  injuryStartDate: string | null;
  practice: string | null;
}

export async function fetchSleeperPlayers(): Promise<SleeperPlayerRow[]> {
  const response = await fetch("https://api.sleeper.app/v1/players/nfl", {
    headers: { "User-Agent": "chaos-league" },
    // Injury designations move daily, and this is the only request that
    // carries them, so it cannot ride a day-long cache.
    next: { revalidate: 60 * 30 },
  });

  if (!response.ok) {
    throw new Error(`Sleeper player dump: ${response.status}`);
  }

  const players = (await response.json()) as Record<string, SleeperPlayer>;
  const rows: SleeperPlayerRow[] = [];

  for (const [key, player] of Object.entries(players)) {
    const name =
      player.full_name?.trim() ||
      [player.first_name, player.last_name].filter(Boolean).join(" ").trim();
    if (!name) continue;

    rows.push({
      sleeperId: player.player_id ?? key,
      // Some of their gsis ids arrive with a leading space --
      // " 00-0035228". Ours never do, so an untrimmed id matches nothing.
      gsisId: player.gsis_id?.trim() || null,
      fullName: name,
      position: player.position?.trim() || null,
      team: normalizeSleeperTeam(player.team),
      injuryStatus: player.injury_status?.trim() || null,
      injuryBodyPart: player.injury_body_part?.trim() || null,
      injuryNotes: player.injury_notes?.trim() || null,
      injuryStartDate: player.injury_start_date ?? null,
      practice: player.practice_participation?.trim() || null,
    });
  }

  return rows;
}

/** Their abbreviations, where they differ from nflverse's. */
const TEAM_ALIASES: Record<string, string> = {
  JAC: "JAX",
  LAR: "LA",
  WSH: "WAS",
  OAK: "LV",
  SD: "LAC",
  STL: "LA",
};

function normalizeSleeperTeam(team: string | null | undefined): string | null {
  const abbr = team?.trim().toUpperCase();
  if (!abbr) return null;
  return TEAM_ALIASES[abbr] ?? abbr;
}

/**
 * Sleeper's player id -> our player id.
 *
 * The gsis id when there is one, because an exact key beats a fuzzy one
 * and costs nothing to try. A name match when there is not, which is
 * now the majority case and covers every player anybody actually drafts.
 *
 * Team defenses are keyed by their abbreviation in Sleeper's world
 * ("KC" rather than a numeric id) and map onto our DST_<abbr>
 * pseudo-players.
 */
export function buildSleeperIdMap(
  rows: SleeperPlayerRow[],
  index: PlayerIndex,
  knownIds: Set<string>,
): Map<string, string> {
  const map = new Map<string, string>();

  for (const row of rows) {
    if (row.position === "DEF") {
      const id = `DST_${row.team ?? row.sleeperId.toUpperCase()}`;
      if (knownIds.has(id)) map.set(row.sleeperId, id);
      continue;
    }

    if (row.gsisId && knownIds.has(row.gsisId)) {
      map.set(row.sleeperId, row.gsisId);
      continue;
    }

    const matched = index.find(row.fullName, row.position, row.team);
    if (matched) map.set(row.sleeperId, matched);
  }

  return map;
}

/**
 * Who is hurt, and with what.
 *
 * Read off the same dump as the id mapping, so this costs no extra
 * request. Sleeper is the only free feed that publishes the body part
 * and the practice report alongside the designation, which between them
 * are what actually answer "is he playing on Sunday".
 */
export interface SleeperInjury {
  playerId: string;
  status: string | null;
  bodyPart: string | null;
  notes: string | null;
  startDate: string | null;
  practice: string | null;
}

export function injuriesFrom(
  rows: SleeperPlayerRow[],
  idMap: Map<string, string>,
): SleeperInjury[] {
  const out: SleeperInjury[] = [];

  for (const row of rows) {
    const playerId = idMap.get(row.sleeperId);
    if (!playerId) continue;

    // "Active" is Sleeper's way of saying nothing is wrong, and a null
    // status means the same. Both are stored as null, so a cleared
    // injury clears rather than reading as a designation.
    const healthy =
      !row.injuryStatus || row.injuryStatus.toLowerCase() === "active";

    out.push({
      playerId,
      status: healthy ? null : row.injuryStatus,
      bodyPart: healthy ? null : row.injuryBodyPart,
      notes: healthy ? null : row.injuryNotes,
      startDate: healthy ? null : row.injuryStartDate,
      practice: healthy ? null : row.practice,
    });
  }

  return out;
}

/** Weekly projections, already keyed by our player ids. */
export async function fetchProjections(
  season: number,
  week: number,
  idMap: Map<string, string>,
): Promise<SleeperProjection[]> {
  const positions = ["QB", "RB", "WR", "TE", "K", "DEF"]
    .map((p) => `position[]=${p}`)
    .join("&");

  const response = await fetch(
    `https://api.sleeper.com/projections/nfl/${season}/${week}` +
      `?season_type=regular&order_by=ppr&${positions}`,
    {
      headers: { "User-Agent": "chaos-league" },
      next: { revalidate: 60 * 60 },
    },
  );

  if (!response.ok) {
    throw new Error(`Sleeper projections ${season} week ${week}: ${response.status}`);
  }

  const rows = (await response.json()) as SleeperProjectionRow[];
  const out: SleeperProjection[] = [];

  for (const row of rows) {
    const playerId = row.player_id ? idMap.get(row.player_id) : undefined;
    if (!playerId || !row.stats) continue;

    const stats: Record<string, number> = {};
    for (const [sleeperKey, value] of Object.entries(row.stats)) {
      const key = STAT_KEYS[sleeperKey];
      if (!key) continue;

      const numeric = Number(value);
      // A projection of zero is real information ("we expect nothing"),
      // but storing thousands of them is noise; the scoring engine
      // treats absent and zero identically anyway.
      if (!Number.isFinite(numeric) || numeric === 0) continue;
      stats[key] = Math.round(numeric * 100) / 100;
    }

    if (Object.keys(stats).length === 0) continue;

    out.push({
      playerId,
      stats,
      opponent: row.opponent ?? null,
      injuryStatus: row.player?.injury_status ?? null,
    });
  }

  return out;
}

/**
 * A whole season's projection, for the draft board.
 *
 * Same endpoint as the weekly one with the week left off, which is what
 * Sleeper's own draft board reads. Same reasoning too: the stat line is
 * what gets stored, so each league scores it with its own rules rather
 * than inheriting somebody else's idea of what a reception is worth.
 *
 * `sourcePoints` is Sleeper's own PPR total, kept only as a fallback
 * ordering for a league that has not set its scoring up yet.
 */
export interface SleeperSeasonProjection {
  playerId: string;
  stats: Record<string, number>;
  sourcePoints: number | null;
}

export async function fetchSeasonProjections(
  season: number,
  idMap: Map<string, string>,
): Promise<SleeperSeasonProjection[]> {
  const positions = ["QB", "RB", "WR", "TE", "K", "DEF"]
    .map((p) => `position[]=${p}`)
    .join("&");

  const response = await fetch(
    `https://api.sleeper.com/projections/nfl/${season}` +
      `?season_type=regular&order_by=pts_ppr&${positions}`,
    {
      headers: { "User-Agent": "chaos-league" },
      next: { revalidate: 60 * 60 * 6 },
    },
  );

  if (!response.ok) {
    throw new Error(`Sleeper season projections ${season}: ${response.status}`);
  }

  const rows = (await response.json()) as SleeperProjectionRow[];
  const out: SleeperSeasonProjection[] = [];

  for (const row of rows) {
    const playerId = row.player_id ? idMap.get(row.player_id) : undefined;
    if (!playerId || !row.stats) continue;

    const stats: Record<string, number> = {};
    for (const [sleeperKey, value] of Object.entries(row.stats)) {
      const key = STAT_KEYS[sleeperKey];
      if (!key) continue;

      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric === 0) continue;
      stats[key] = Math.round(numeric * 100) / 100;
    }

    if (Object.keys(stats).length === 0) continue;

    const ppr = Number(row.stats.pts_ppr);
    out.push({
      playerId,
      stats,
      sourcePoints: Number.isFinite(ppr) ? Math.round(ppr * 100) / 100 : null,
    });
  }

  return out;
}
