"use client";

import { useState } from "react";
import type { Team, Trade } from "@/lib/types";
import type { ValuedPlayer } from "@/lib/trade-finder";
import type { TradeItemRow, TradePlayerOption } from "./page";
import { TradeFinder, TradingBlock } from "./finder";
import { TradeList } from "./trade-list";
import { ProposeTrade } from "./propose-trade";

type TabId = "finder" | "block" | "proposals";

const TABS: { id: TabId; label: string }[] = [
  { id: "finder", label: "Trade finder" },
  { id: "block", label: "Trading block" },
  { id: "proposals", label: "Proposals" },
];

export function TradeTabs({
  leagueId,
  myTeam,
  teams,
  values,
  trades,
  items,
  playerNames,
  rosters,
  initialPartner,
  pendingForMe,
}: {
  leagueId: string;
  myTeam: Team | null;
  teams: Team[];
  values: ValuedPlayer[];
  trades: Trade[];
  items: TradeItemRow[];
  playerNames: Record<string, string>;
  rosters: Record<string, TradePlayerOption[]>;
  initialPartner: string | null;
  pendingForMe: number;
}) {
  // Arriving from a team page means you already have somebody in mind,
  // so open on the finder with them selected.
  const [tab, setTab] = useState<TabId>(
    pendingForMe > 0 && !initialPartner ? "proposals" : "finder",
  );

  return (
    <div className="space-y-4">
      <nav className="flex gap-2 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`btn btn-sm ${tab === t.id ? "btn-primary" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === "proposals" && pendingForMe > 0 && (
              <span className="pill ml-2">{pendingForMe}</span>
            )}
          </button>
        ))}
      </nav>

      {tab === "finder" &&
        (myTeam ? (
          <TradeFinder
            leagueId={leagueId}
            myTeam={myTeam}
            teams={teams}
            values={values}
            initialPartner={initialPartner}
          />
        ) : (
          <p className="card muted">
            You need a team before you can trade. Pick one off the board.
          </p>
        ))}

      {tab === "block" && (
        <TradingBlock
          leagueId={leagueId}
          myTeam={myTeam}
          teams={teams}
          values={values}
        />
      )}

      {tab === "proposals" && (
        <div className="space-y-4">
          {myTeam && teams.length > 1 && (
            <ProposeTrade
              leagueId={leagueId}
              myTeam={myTeam}
              otherTeams={teams.filter((t) => t.id !== myTeam.id)}
              rosters={rosters}
            />
          )}
          <TradeList
            leagueId={leagueId}
            trades={trades}
            items={items}
            teams={teams}
            myTeamId={myTeam?.id ?? null}
            playerNames={playerNames}
          />
        </div>
      )}
    </div>
  );
}
