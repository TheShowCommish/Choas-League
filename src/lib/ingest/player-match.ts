/**
 * Putting an outside feed's players onto our own ids.
 *
 * Every feed here names players its own way and only some of them carry
 * a cross-reference id worth anything. Sleeper's player dump publishes a
 * `gsis_id` field -- our own primary key -- but has quietly stopped
 * filling it in: of 12,000 entries fewer than 4,000 carry one, and the
 * ones that do skew heavily to players who have retired. Ja'Marr Chase,
 * Jahmyr Gibbs, Bijan Robinson and Puka Nacua all come back with null.
 *
 * So an exact id is a bonus rather than the plan. The plan is the name,
 * qualified by position and, where two people share both, by NFL team.
 * That is the same problem the mock drafts pose -- they publish nothing
 * but a name -- which is why one index answers for both.
 */

/** One of our players, as much as the matcher needs to know. */
export interface MatchablePlayer {
  id: string;
  full_name: string;
  position: string | null;
  team_abbr: string | null;
}

/**
 * A name reduced to the part two feeds are likely to agree on.
 *
 * Punctuation is the usual culprit -- "Ja'Marr" against "JaMarr",
 * "D.K." against "DK" -- and generational suffixes are the other, since
 * one feed's "Marvin Harrison Jr." is another's "Marvin Harrison".
 *
 * Decomposing to NFD before stripping everything outside a-z is what
 * handles accents: the accent becomes a separate combining character
 * and is thrown away with the punctuation, leaving the bare letter.
 */
export function matchName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "")
    .replace(/[^a-z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Our players, indexed for matching by name.
 *
 * Built once per job and asked once per incoming row, because the
 * alternative -- a linear scan of three and a half thousand players per
 * row of a three thousand row feed -- is ten million string
 * comparisons.
 */
export class PlayerIndex {
  private readonly byNamePos = new Map<string, MatchablePlayer[]>();
  private readonly byNameOnly = new Map<string, MatchablePlayer[]>();

  constructor(players: MatchablePlayer[]) {
    for (const player of players) {
      const name = matchName(player.full_name);
      if (!name) continue;

      push(this.byNameOnly, name, player);
      if (player.position) {
        push(this.byNamePos, `${name}|${player.position}`, player);
      }
    }
  }

  /**
   * The one player this name means, or null.
   *
   * Null rather than a guess is the whole point. A wrong match puts
   * somebody else's projection, ADP or injury on a player, which on a
   * draft board is worse than having none: it looks like information.
   *
   * Three passes, narrowing only when it has to. Name and position is
   * the normal case. When that is ambiguous -- there really are two
   * Michael Carters at running back -- the NFL team separates them.
   * When the position disagrees between the feeds (they argue about
   * fullbacks, and about whether a converted receiver is still one) the
   * name alone is tried, but only if it is unique on its own.
   */
  find(
    name: string,
    position: string | null,
    team: string | null,
  ): string | null {
    const key = matchName(name);
    if (!key) return null;

    if (position) {
      const exact = this.byNamePos.get(`${key}|${position}`);
      if (exact?.length === 1) return exact[0].id;
      if (exact && exact.length > 1) {
        return exact.find((p) => p.team_abbr === team)?.id ?? null;
      }
    }

    const anyPosition = this.byNameOnly.get(key);
    if (anyPosition?.length === 1) return anyPosition[0].id;
    if (anyPosition && anyPosition.length > 1 && team) {
      const sameTeam = anyPosition.filter((p) => p.team_abbr === team);
      if (sameTeam.length === 1) return sameTeam[0].id;
    }

    return null;
  }
}

function push<T>(map: Map<string, T[]>, key: string, value: T) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
