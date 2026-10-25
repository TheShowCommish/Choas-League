/*
 * Trade impact preview (T-073).
 *
 * Pure, no database: given each side's roster and the players moving each
 * way, work out how a proposed trade changes both teams' best starting
 * lineup, and whether either side ends up in an illegal roster state. The
 * propose screen and the trade inbox both drive their decision-support off
 * these numbers; the designer owns how they finally read.
 *
 * Relative imports with the .ts the runtime wants: this helper is unit-tested
 * under `node --test`, which resolves neither the "@/" tsconfig alias nor an
 * extensionless specifier. The slot and lineup helpers it leans on are the
 * same ones the lineup editor uses, so the "best lineup" here is the one the
 * rest of the app would fill.
 */
import { expandSlots } from "./roster-slots.ts";
import { autoFill } from "./lineup.ts";

/** One rostered player, reduced to what trade impact needs to weigh him. */
export interface TradePlayer {
  playerId: string;
  position: string | null;
  /**
   * Season average points in this league's rules -- the stable value metric
   * the best-lineup total is summed in (league_trade_values, 0029).
   */
  avg: number;
  /**
   * Next-week projection, scored in this league's rules (team_projections,
   * 0028). For per-player display only; it does not feed the lineup total,
   * which stays on the steadier season average. Null when none is available.
   */
  projection: number | null;
}

/** A roster slot, as much of one as the lineup fill and the caps need. */
export interface ImpactSlot {
  slot_key: string;
  label: string;
  count: number;
  is_starter: boolean;
  eligible_positions: string[];
}

/** A position the roster would be over its league limit at, after the swap. */
export interface PositionViolation {
  position: string;
  count: number;
  max: number;
}

/** Whether a team's post-trade roster is a legal one. */
export interface Legality {
  rosterSize: number;
  /** The league's roster cap: the sum of every slot's count. */
  rosterCapacity: number;
  /** More players than the roster holds -- the trade cannot go through as is. */
  overCapacity: boolean;
  /** Positions the team would be over its league limit at. */
  positionOver: PositionViolation[];
  legal: boolean;
}

/** One team's before/after, and where it lands. */
export interface TeamImpact {
  /** Best starting-lineup total (season avg) on the current roster. */
  before: number;
  /** ...and after the trade goes through. */
  after: number;
  /** after - before. Positive means the trade lifts this team's lineup. */
  delta: number;
  legality: Legality;
}

/** What one side of a trade does to one team: who leaves, who arrives. */
export interface SideInput {
  /** The team's full active roster (every player it holds). */
  roster: TradePlayer[];
  /** Player ids leaving this team. */
  outgoing: string[];
  /** Players arriving, with their value carried from the other roster. */
  incoming: TradePlayer[];
}

/** Both teams' impact, keyed by their role in the trade. */
export interface TradeImpact {
  proposing: TeamImpact;
  receiving: TeamImpact;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The best starting lineup a roster can field, summed in season average.
 *
 * Fills the board the way the lineup editor would -- autoFill deals the
 * best eligible player into each starting spot first -- then adds up the
 * average of whoever lands in a starting slot. Bench players and anyone the
 * roster has no room for are left out, exactly as they are on game day.
 */
export function bestLineupTotal(
  roster: TradePlayer[],
  slots: ImpactSlot[],
): number {
  const spots = expandSlots(slots);
  const placed = autoFill(
    {},
    spots,
    roster.map((p) => ({
      playerId: p.playerId,
      points: p.avg,
      player: { position: p.position },
    })),
  );

  const avgById = new Map(roster.map((p) => [p.playerId, p.avg]));
  const starterKeys = new Set(
    spots.filter((s) => s.isStarter).map((s) => s.key),
  );

  let total = 0;
  for (const [spotKey, playerId] of Object.entries(placed)) {
    if (!playerId || !starterKeys.has(spotKey)) continue;
    total += avgById.get(playerId) ?? 0;
  }
  return round2(total);
}

/** The roster a team would hold after the swap: drop the leavers, add the joiners. */
export function rosterAfter(
  roster: TradePlayer[],
  outgoing: string[],
  incoming: TradePlayer[],
): TradePlayer[] {
  const leaving = new Set(outgoing);
  return [...roster.filter((p) => !leaving.has(p.playerId)), ...incoming];
}

/**
 * Is this post-trade roster legal: within the roster cap and within every
 * per-position limit?
 *
 * The cap is the sum of the league's slots (roster_capacity, 0011); a
 * position limit of null/absent means no limit (league_position_limits,
 * 0026). Being *under* the cap is fine -- empty bench spots are legal -- so
 * only going over it is flagged; the raw size and capacity are returned so a
 * caller can still show "12 / 16".
 */
export function checkLegality(
  roster: TradePlayer[],
  slots: ImpactSlot[],
  positionLimits: Record<string, number>,
): Legality {
  const rosterCapacity = slots.reduce((n, s) => n + s.count, 0);
  const rosterSize = roster.length;

  const counts = new Map<string, number>();
  for (const p of roster) {
    if (!p.position) continue;
    counts.set(p.position, (counts.get(p.position) ?? 0) + 1);
  }

  const positionOver: PositionViolation[] = [];
  for (const [position, max] of Object.entries(positionLimits)) {
    const count = counts.get(position) ?? 0;
    if (count > max) positionOver.push({ position, count, max });
  }
  positionOver.sort((a, b) => a.position.localeCompare(b.position));

  const overCapacity = rosterSize > rosterCapacity;

  return {
    rosterSize,
    rosterCapacity,
    overCapacity,
    positionOver,
    legal: !overCapacity && positionOver.length === 0,
  };
}

/** One team's before/after lineup total and post-trade legality. */
export function teamImpact(
  side: SideInput,
  slots: ImpactSlot[],
  positionLimits: Record<string, number>,
): TeamImpact {
  const before = bestLineupTotal(side.roster, slots);
  const afterRoster = rosterAfter(side.roster, side.outgoing, side.incoming);
  const after = bestLineupTotal(afterRoster, slots);
  return {
    before,
    after,
    delta: round2(after - before),
    legality: checkLegality(afterRoster, slots, positionLimits),
  };
}

/**
 * The whole trade's impact: what each team gives up, gets back, and where its
 * lineup and roster land. The proposing team gives `proposingGives` and gets
 * `receivingGives`; the receiving team is the mirror.
 */
export function tradeImpact(
  proposing: SideInput,
  receiving: SideInput,
  slots: ImpactSlot[],
  positionLimits: Record<string, number>,
): TradeImpact {
  return {
    proposing: teamImpact(proposing, slots, positionLimits),
    receiving: teamImpact(receiving, slots, positionLimits),
  };
}
