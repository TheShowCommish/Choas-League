/**
 * The slice of a player the draft board actually renders.
 *
 * `league_player_pool` returns two dozen columns -- owner, waiver, next
 * game, headshot, availability -- all useful on the Players tab and none
 * of them on the draft board. Shipping all of them for a 500-player pool
 * is a large payload the room parses on first load and again on every
 * refresh. `toDraftablePlayer` keeps only the eleven fields the board and
 * the auction floor read, so the wire carries roughly half as much.
 */
export interface DraftablePlayer {
  player_id: string;
  full_name: string;
  pos: string | null;
  team_abbr: string | null;
  total_points: number;
  adp: number | null;
  adp_rank: number | null;
  /** This season's projection, scored with this league's rules. */
  proj_points: number | null;
  injury_status: string | null;
  injury_body_part: string | null;
  bye_week: number | null;
}

/** Every column `league_player_pool` can hand back, before we thin it. */
export interface PoolRpcRow {
  player_id: string;
  full_name: string;
  pos: string | null;
  team_abbr: string | null;
  total_points: number;
  adp: number | null;
  adp_rank: number | null;
  proj_points: number | null;
  injury_status: string | null;
  injury_body_part: string | null;
  bye_week: number | null;
  [column: string]: unknown;
}

/**
 * Drop everything the draft room never looks at. A projection rather than
 * a cast: `as DraftablePlayer` quietly keeps all two dozen columns on the
 * object and serialises every one of them to the browser.
 */
export function toDraftablePlayer(row: PoolRpcRow): DraftablePlayer {
  return {
    player_id: row.player_id,
    full_name: row.full_name,
    pos: row.pos,
    team_abbr: row.team_abbr,
    total_points: row.total_points,
    adp: row.adp,
    adp_rank: row.adp_rank,
    proj_points: row.proj_points,
    injury_status: row.injury_status,
    injury_body_part: row.injury_body_part,
    bye_week: row.bye_week,
  };
}

/**
 * How many pool rows the board renders at once.
 *
 * The server ships 500 so search and the position filter -- both run in
 * the client -- can reach anybody worth reaching. The DOM does not need
 * all 500 at once: a draft is made from the top of the order or by
 * searching a name, so rendering the first slice and letting the filters
 * narrow the rest keeps the table from reconciling hundreds of rows on
 * every pick while never hiding a player a search would surface.
 */
export const DRAFT_POOL_RENDER_LIMIT = 200;
