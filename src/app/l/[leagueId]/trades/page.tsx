import { getLeagueContext } from "@/lib/league";
import { getTeamRoster } from "@/lib/roster";
import { createClient } from "@/lib/supabase/server";
import type { Trade } from "@/lib/types";
import type { ValuedPlayer } from "@/lib/trade-finder";
import {
  tradeImpact,
  type SideInput,
  type TradeImpact,
  type TradePlayer,
} from "@/lib/trade-impact";
import { TradeTabs } from "./tabs";
import { positionLabel } from "@/lib/roster-slots";

export interface TradeItemRow {
  id: string;
  trade_id: string;
  from_team_id: string;
  player_id: string | null;
  faab_amount: number | null;
}

/**
 * A tradeable player with the decision-support numbers T-073 shows next to
 * him: his label, his season average and his next-week projection, plus the
 * position the legality check counts him under.
 */
export interface TradePlayerOption {
  playerId: string;
  label: string;
  position: string | null;
  /** Season average points in this league's rules (league_trade_values). */
  avg: number;
  /** Next-week projection in this league's rules; null when none (team_projections). */
  projection: number | null;
}

export default async function TradesPage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string }>;
  searchParams: Promise<{ with?: string }>;
}) {
  const { leagueId } = await params;
  const { with: partner } = await searchParams;
  const { league, teams, myTeam, rosterSlots } =
    await getLeagueContext(leagueId);
  const supabase = await createClient();

  const [{ data: trades }, { data: items }] = await Promise.all([
    supabase
      .from("trades")
      .select("*")
      .eq("league_id", leagueId)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("trade_items")
      .select("id, trade_id, from_team_id, player_id, faab_amount"),
  ]);

  const { data: valueRows } = await supabase.rpc("league_trade_values", {
    p_league: leagueId,
  });

  const values: ValuedPlayer[] = (valueRows ?? []).map(
    (row: {
      player_id: string;
      full_name: string;
      pos: string | null;
      team_abbr: string | null;
      owner_team_id: string;
      on_block: boolean;
      games: number;
      avg_points: number;
      value: number;
    }) => ({
      playerId: row.player_id,
      fullName: row.full_name,
      position: row.pos,
      teamAbbr: row.team_abbr,
      ownerTeamId: row.owner_team_id,
      onBlock: row.on_block,
      games: Number(row.games),
      avgPoints: Number(row.avg_points),
      value: Number(row.value),
    }),
  );

  const tradeRows = (trades ?? []) as Trade[];
  const itemRows = (items ?? []) as TradeItemRow[];

  // Names for every player mentioned in a trade, so the list reads.
  const playerIds = [
    ...new Set(itemRows.map((i) => i.player_id).filter((id): id is string => !!id)),
  ];

  const { data: players } = playerIds.length
    ? await supabase
        .from("nfl_players")
        .select("id, full_name, position")
        .in("id", playerIds)
    : { data: [] };

  const playerNames = Object.fromEntries(
    (players ?? []).map((p) => [
      p.id as string,
      `${p.full_name}${p.position ? ` (${positionLabel(p.position)})` : ""}`,
    ]),
  );

  // Rosters for the trade builder: mine, and every other team's.
  const otherTeams = teams.filter((t) => t.id !== myTeam?.id);
  const rosterTeams = myTeam ? [myTeam, ...otherTeams] : [];

  // Season average per player, straight off the trade-value RPC.
  const avgByPlayer = new Map(values.map((v) => [v.playerId, v.avgPoints]));

  // Per-position roster caps for the legality check; an absent position
  // means no limit (league_position_limits, 0026).
  const { data: limitRows } = await supabase
    .from("league_position_limits")
    .select("position, max_count")
    .eq("league_id", leagueId);
  const positionLimits: Record<string, number> = Object.fromEntries(
    ((limitRows ?? []) as { position: string; max_count: number }[]).map((r) => [
      r.position,
      r.max_count,
    ]),
  );

  // Each team's active roster, every player carrying the numbers the trade
  // preview weighs him by: season average (the lineup-total metric, T-073)
  // and his next-week projection for display. Projections come from the same
  // RPC the live matchup uses (team_projections, 0028); a missing one is null.
  const rosterEntries = await Promise.all(
    rosterTeams.map(async (team) => {
      const [roster, { data: projRows }] = await Promise.all([
        getTeamRoster(leagueId, team.id, league.season, league.current_week),
        supabase.rpc("team_projections", {
          p_league: leagueId,
          p_team: team.id,
          p_season: league.season,
          p_week: league.current_week,
        }),
      ]);
      const projByPlayer = new Map(
        ((projRows ?? []) as { player_id: string; points: number }[]).map((r) => [
          r.player_id,
          Number(r.points),
        ]),
      );
      const options: TradePlayerOption[] = roster
        // Only players the team actually holds can be traded.
        .filter((r) => r.onRoster)
        .map((r) => ({
          playerId: r.playerId,
          label: `${r.player.full_name} (${positionLabel(r.player.position)})`,
          position: r.player.position,
          avg: avgByPlayer.get(r.playerId) ?? 0,
          projection: projByPlayer.has(r.playerId)
            ? projByPlayer.get(r.playerId)!
            : null,
        }));
      return [team.id, options] as const;
    }),
  );
  const rosters: Record<string, TradePlayerOption[]> =
    Object.fromEntries(rosterEntries);

  // Every tradeable player, keyed for lookup: the inbox needs each named
  // player's value, and a trade's incoming players come from the other side.
  const playerById = new Map<string, TradePlayerOption>();
  for (const list of Object.values(rosters)) {
    for (const p of list) playerById.set(p.playerId, p);
  }

  // Value per player mentioned in any trade, for the inbox's per-player line.
  // A player no longer on a roster (moved, dropped) still has a season average.
  const playerValues: Record<string, { avg: number; projection: number | null }> =
    {};
  for (const id of playerIds) {
    const opt = playerById.get(id);
    playerValues[id] = {
      avg: opt?.avg ?? avgByPlayer.get(id) ?? 0,
      projection: opt?.projection ?? null,
    };
  }

  // Before/after lineup totals and legality for each pending trade, so the
  // inbox shows the same decision support the propose screen computes live.
  const toTradePlayer = (id: string): TradePlayer =>
    playerById.get(id) ?? {
      playerId: id,
      position: null,
      avg: avgByPlayer.get(id) ?? 0,
      projection: null,
    };

  const impacts: Record<string, TradeImpact> = {};
  for (const trade of tradeRows) {
    if (trade.status !== "pending") continue;
    const propRoster = rosters[trade.proposing_team_id];
    const recvRoster = rosters[trade.receiving_team_id];
    if (!propRoster || !recvRoster) continue;

    const tItems = itemRows.filter((i) => i.trade_id === trade.id);
    const propGives = tItems
      .filter((i) => i.from_team_id === trade.proposing_team_id && i.player_id)
      .map((i) => i.player_id!);
    const recvGives = tItems
      .filter((i) => i.from_team_id === trade.receiving_team_id && i.player_id)
      .map((i) => i.player_id!);

    const proposing: SideInput = {
      roster: propRoster,
      outgoing: propGives,
      incoming: recvGives.map(toTradePlayer),
    };
    const receiving: SideInput = {
      roster: recvRoster,
      outgoing: recvGives,
      incoming: propGives.map(toTradePlayer),
    };
    impacts[trade.id] = tradeImpact(
      proposing,
      receiving,
      rosterSlots,
      positionLimits,
    );
  }

  const pendingForMe = myTeam
    ? tradeRows.filter(
        (t) => t.status === "pending" && t.receiving_team_id === myTeam.id,
      ).length
    : 0;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="h1">Trades</h1>
        <p className="muted">
          Nothing moves until the other manager accepts. Every completed trade
          lands in the transaction log.
        </p>
      </header>

      <TradeTabs
        leagueId={leagueId}
        myTeam={myTeam}
        teams={teams}
        values={values}
        trades={tradeRows}
        items={itemRows}
        playerNames={playerNames}
        playerValues={playerValues}
        rosters={rosters}
        rosterSlots={rosterSlots}
        positionLimits={positionLimits}
        impacts={impacts}
        initialPartner={partner ?? null}
        pendingForMe={pendingForMe}
      />
    </div>
  );
}
