import "server-only";

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
  injury_status?: string | null;
}

interface SleeperProjectionRow {
  player_id?: string;
  stats?: Record<string, unknown>;
  opponent?: string | null;
  player?: { injury_status?: string | null } | null;
}

/**
 * Sleeper's player id -> our gsis id.
 *
 * Their dump is ~12k players and about 3.9k carry a gsis_id, which is
 * every player who has actually appeared in a game. The rest are
 * college and practice-squad rows we have no use for.
 */
export async function fetchSleeperIdMap(): Promise<Map<string, string>> {
  const response = await fetch("https://api.sleeper.app/v1/players/nfl", {
    headers: { "User-Agent": "chaos-league" },
    // The dump changes slowly and is several megabytes.
    next: { revalidate: 60 * 60 * 24 },
  });

  if (!response.ok) {
    throw new Error(`Sleeper player dump: ${response.status}`);
  }

  const players = (await response.json()) as Record<string, SleeperPlayer>;
  const map = new Map<string, string>();

  for (const player of Object.values(players)) {
    if (player.player_id && player.gsis_id) {
      map.set(player.player_id, player.gsis_id);
    }
  }
  return map;
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
