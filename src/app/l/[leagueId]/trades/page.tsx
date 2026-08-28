import { getLeagueContext } from "@/lib/league";
import { getTeamRoster } from "@/lib/roster";
import { createClient } from "@/lib/supabase/server";
import type { Trade } from "@/lib/types";
import { TradeList } from "./trade-list";
import { ProposeTrade } from "./propose-trade";

export interface TradeItemRow {
  id: string;
  trade_id: string;
  from_team_id: string;
  player_id: string | null;
  faab_amount: number | null;
}

export interface TradePlayerOption {
  playerId: string;
  label: string;
}

export default async function TradesPage({
  params,
}: {
  params: Promise<{ leagueId: string }>;
}) {
  const { leagueId } = await params;
  const { league, teams, myTeam } = await getLeagueContext(leagueId);
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
      `${p.full_name}${p.position ? ` (${p.position})` : ""}`,
    ]),
  );

  // Rosters for the trade builder: mine, and every other team's.
  const otherTeams = teams.filter((t) => t.id !== myTeam?.id);

  const rosters = myTeam
    ? Object.fromEntries(
        await Promise.all(
          [myTeam, ...otherTeams].map(async (team) => {
            const roster = await getTeamRoster(
              leagueId,
              team.id,
              league.season,
              league.current_week,
            );
            return [
              team.id,
              roster.map((r) => ({
                playerId: r.playerId,
                label: `${r.player.full_name} (${r.player.position ?? "?"})`,
              })),
            ] as const;
          }),
        ),
      )
    : {};

  return (
    <div className="space-y-5">
      <header>
        <h1 className="h1">Trades</h1>
        <p className="muted">
          Nothing moves until the other manager accepts. Every completed trade
          lands in the transaction log.
        </p>
      </header>

      {myTeam && otherTeams.length > 0 && (
        <ProposeTrade
          leagueId={leagueId}
          myTeam={myTeam}
          otherTeams={otherTeams}
          rosters={rosters as Record<string, TradePlayerOption[]>}
        />
      )}

      <TradeList
        leagueId={leagueId}
        trades={tradeRows}
        items={itemRows}
        teams={teams}
        myTeamId={myTeam?.id ?? null}
        playerNames={playerNames}
      />
    </div>
  );
}
