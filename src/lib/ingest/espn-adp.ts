/**
 * Draft order, from ESPN's fantasy player service.
 *
 * A draft board sorted by last season's points puts the players who
 * scored most last year at the top, which is not the same thing as the
 * players people are drafting -- it buries rookies, it buries anybody
 * who was hurt, and it flatters a career year. This is the order the
 * room is actually working from.
 *
 * This is the endpoint the public ESPN draft-kit pages call. It is
 * undocumented, needs no key, and wants its query in an `x-fantasy-filter`
 * header rather than the query string. Treat every field as optional.
 *
 * Two kinds of row come back. A real player carries an ESPN athlete id,
 * which we already store on nfl_players.espn_id. A D/ST carries the
 * negative of its pro team id and no athlete id at all, so it is matched
 * to the DST_<abbr> pseudo-player by team instead.
 */

const PLAYER_SERVICE =
  "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons";

/**
 * ESPN's own team numbering. Abbreviations are given in nflverse form
 * (LA for the Rams, WAS, LV, JAX) so they join straight onto nfl_teams.
 *
 * 31 and 32 are unused by ESPN; the list really does jump to 33/34.
 */
const PRO_TEAMS: Record<number, string> = {
  1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN",
  8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LA",
  15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ",
  21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA",
  27: "TB", 28: "WAS", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
};

/** ESPN's defaultPositionId. 16 is a team defense. */
const DEFENSE_POSITION_ID = 16;

/** Which of ESPN's two numbers the ordering was taken from. */
export type AdpSource = "espn" | "espn-rank";

export interface AdpEntry {
  /** ESPN athlete id, or null for a team defense. */
  espnId: string | null;
  /** Set only for a team defense, so it can be matched by team. */
  defenseTeam: string | null;
  name: string;
  /** The value stored as ADP. Lower is earlier. */
  adp: number;
  /** Position in this list once sorted, 1-based. */
  rank: number;
  source: AdpSource;
}

/** What ESPN said about one player, before we decide what to trust. */
interface RawEntry {
  espnId: string | null;
  defenseTeam: string | null;
  name: string;
  /** ownership.averageDraftPosition, or null when absent or zero. */
  reportedAdp: number | null;
  /** draftRanksByRankType.PPR.rank, or null when absent. */
  draftRank: number | null;
}

interface PlayerServiceResponse {
  players?: {
    id?: number;
    player?: {
      fullName?: string;
      defaultPositionId?: number;
      proTeamId?: number;
      ownership?: { averageDraftPosition?: number };
      draftRanksByRankType?: Record<string, { rank?: number }>;
    };
  }[];
}

/**
 * The filter ESPN wants. `limit` is the only part that matters much --
 * 1200 is comfortably past the point where draft order stops meaning
 * anything, and the service caps the page itself anyway.
 */
function filterHeader(limit: number): string {
  return JSON.stringify({
    players: {
      limit,
      sortDraftRanks: {
        sortPriority: 100,
        sortAsc: true,
        value: "PPR",
      },
    },
  });
}

/**
 * Is ESPN's reported ADP a real number, or its placeholder?
 *
 * Outside the weeks when people are actually drafting, ESPN returns the
 * *same* averageDraftPosition for every player -- 170 across all 400 of
 * the top players, checked against the live service. Sorting on that
 * produces no order whatsoever, which is worse than useless on a draft
 * board because it looks like an order.
 *
 * Real ADP has a distinct value for very nearly every player, so a
 * handful of distinct values across hundreds of rows is the placeholder
 * and the editorial draft rank is the better number to keep.
 */
export function adpIsMeaningful(reported: (number | null)[]): boolean {
  const values = reported.filter((v): v is number => v !== null);
  if (values.length === 0) return false;

  const distinct = new Set(values).size;
  return distinct >= Math.max(20, Math.floor(values.length / 20));
}

/**
 * Turns what ESPN said into one ordering.
 *
 * Prefers real ADP and falls back to the PPR draft rank, which is
 * ESPN's own editorial ranking and is always populated. Either way the
 * result is renumbered from 1, so `rank` means the same thing whichever
 * number it came from.
 */
export function resolveOrdering(raw: RawEntry[]): AdpEntry[] {
  const useAdp = adpIsMeaningful(raw.map((r) => r.reportedAdp));
  const source: AdpSource = useAdp ? "espn" : "espn-rank";

  const entries: AdpEntry[] = [];
  for (const row of raw) {
    const value = useAdp ? row.reportedAdp : row.draftRank;
    if (value === null || !Number.isFinite(value) || value <= 0) continue;

    entries.push({
      espnId: row.espnId,
      defenseTeam: row.defenseTeam,
      name: row.name,
      adp: Math.round(value * 100) / 100,
      rank: 0,
      source,
    });
  }

  // Renumber by the value actually stored, so the two never disagree.
  entries.sort((a, b) => a.adp - b.adp);
  entries.forEach((entry, index) => {
    entry.rank = index + 1;
  });

  return entries;
}

export async function fetchEspnAdp(
  season: number,
  limit = 1200,
): Promise<AdpEntry[]> {
  const url =
    `${PLAYER_SERVICE}/${season}/segments/0/leaguedefaults/3` +
    `?view=kona_player_info`;

  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      "x-fantasy-filter": filterHeader(limit),
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`ESPN player service ${response.status}`);
  }

  const data = (await response.json()) as PlayerServiceResponse;
  const raw: RawEntry[] = [];

  for (const row of data.players ?? []) {
    const player = row.player;
    if (!player) continue;

    const isDefense = player.defaultPositionId === DEFENSE_POSITION_ID;
    const team = PRO_TEAMS[player.proTeamId ?? 0] ?? null;

    // A defense with no team we recognise cannot be matched to anything.
    if (isDefense && !team) continue;

    // An undrafted player comes back as 0, which would sort him first.
    const reported = player.ownership?.averageDraftPosition;
    const draftRank = player.draftRanksByRankType?.PPR?.rank;

    raw.push({
      espnId: isDefense || row.id === undefined ? null : String(row.id),
      defenseTeam: isDefense ? team : null,
      name: player.fullName ?? "",
      reportedAdp:
        typeof reported === "number" && Number.isFinite(reported) && reported > 0
          ? reported
          : null,
      draftRank:
        typeof draftRank === "number" && Number.isFinite(draftRank) && draftRank > 0
          ? draftRank
          : null,
    });
  }

  return resolveOrdering(raw);
}
