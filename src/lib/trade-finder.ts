/**
 * Finding trades of roughly equal value.
 *
 * Pure functions, no database: this is the one piece of trade logic
 * worth testing directly, and it needs nothing but numbers.
 *
 * The search is deliberately shallow -- one or two players coming back
 * for whatever you offered. Three-for-two packages are combinatorially
 * expensive and, in practice, nobody accepts them.
 */

export interface ValuedPlayer {
  playerId: string;
  fullName: string;
  position: string | null;
  teamAbbr: string | null;
  ownerTeamId: string;
  onBlock: boolean;
  games: number;
  avgPoints: number;
  value: number;
}

export interface TradeSuggestion {
  /** The other side of the deal. */
  teamId: string;
  receive: ValuedPlayer[];
  give: ValuedPlayer[];
  giveValue: number;
  receiveValue: number;
  /** receive - give. Positive means the deal favours you. */
  difference: number;
  /**
   * How lopsided, as a share of the larger side. 0 is a dead heat, 1
   * would be getting something for nothing.
   */
  imbalance: number;
}

/** Sum of a side's value, rounded so the UI never shows 12.300000000001. */
function sum(players: ValuedPlayer[]): number {
  return Math.round(players.reduce((n, p) => n + p.value, 0) * 10) / 10;
}

export function imbalanceOf(giveValue: number, receiveValue: number): number {
  const larger = Math.max(giveValue, receiveValue);
  if (larger === 0) return 0;
  return Math.abs(receiveValue - giveValue) / larger;
}

/**
 * Every package worth at least as much as `tolerance` allows.
 *
 * `tolerance` is 0..1: the largest imbalance to accept, as a share of
 * the bigger side. 0.1 means "within 10% either way".
 */
export function findTrades(
  give: ValuedPlayer[],
  candidates: ValuedPlayer[],
  {
    tolerance = 0.15,
    maxIncoming = 2,
    limit = 40,
    blockOnly = false,
  }: {
    tolerance?: number;
    maxIncoming?: number;
    limit?: number;
    blockOnly?: boolean;
  } = {},
): TradeSuggestion[] {
  if (give.length === 0) return [];

  const giveValue = sum(give);
  const giving = new Set(give.map((p) => p.playerId));

  const pool = candidates.filter(
    (p) => !giving.has(p.playerId) && (!blockOnly || p.onBlock),
  );

  // Grouped by team: a trade is with one manager, so a package can never
  // mix two teams' players.
  const byTeam = new Map<string, ValuedPlayer[]>();
  for (const player of pool) {
    const list = byTeam.get(player.ownerTeamId) ?? [];
    list.push(player);
    byTeam.set(player.ownerTeamId, list);
  }

  const out: TradeSuggestion[] = [];

  for (const [teamId, players] of byTeam) {
    const sorted = [...players].sort((a, b) => b.value - a.value);

    const consider = (receive: ValuedPlayer[]) => {
      const receiveValue = sum(receive);
      const imbalance = imbalanceOf(giveValue, receiveValue);
      if (imbalance > tolerance) return;

      out.push({
        teamId,
        receive,
        give,
        giveValue,
        receiveValue,
        difference: Math.round((receiveValue - giveValue) * 10) / 10,
        imbalance,
      });
    };

    for (let i = 0; i < sorted.length; i++) {
      consider([sorted[i]]);

      if (maxIncoming < 2) continue;
      for (let j = i + 1; j < sorted.length; j++) {
        // Sorted descending, so once a pair is too rich every later
        // pair with the same i is too, and we can stop early.
        if (sum([sorted[i], sorted[j]]) > giveValue * (1 + tolerance)) continue;
        consider([sorted[i], sorted[j]]);
      }
    }
  }

  // Fairest first, then the ones that favour you.
  out.sort(
    (a, b) => a.imbalance - b.imbalance || b.difference - a.difference,
  );

  return out.slice(0, limit);
}
