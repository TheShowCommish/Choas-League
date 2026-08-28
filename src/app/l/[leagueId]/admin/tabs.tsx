"use client";

import { useState } from "react";
import type {
  Draft,
  League,
  RosterSlot,
  ScoringRule,
  StatDefinition,
  Team,
} from "@/lib/types";
import { SettingsPanel } from "./settings-panel";
import { ScoringPanel } from "./scoring-panel";
import { RosterPanel } from "./roster-panel";
import { ToolsPanel } from "./tools-panel";

export interface MemberRow {
  id: string;
  display_name: string;
  email: string;
  role: string;
}

const TABS = [
  { id: "scoring", label: "Scoring" },
  { id: "roster", label: "Roster" },
  { id: "settings", label: "Settings" },
  { id: "tools", label: "Tools" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function AdminTabs({
  league,
  teams,
  rosterSlots,
  stats,
  rules,
  members,
  draft,
}: {
  league: League;
  teams: Team[];
  rosterSlots: RosterSlot[];
  stats: StatDefinition[];
  rules: ScoringRule[];
  members: MemberRow[];
  draft: Draft | null;
}) {
  const [tab, setTab] = useState<TabId>("scoring");

  return (
    <>
      <div className="table-scroll">
        <div className="flex gap-1 border-b border-border">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`border-b-2 px-3 py-2 text-sm whitespace-nowrap ${
                tab === t.id
                  ? "border-accent text-accent"
                  : "border-transparent text-muted hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "scoring" && (
        <ScoringPanel leagueId={league.id} stats={stats} rules={rules} />
      )}
      {tab === "roster" && (
        <RosterPanel leagueId={league.id} slots={rosterSlots} />
      )}
      {tab === "settings" && <SettingsPanel league={league} />}
      {tab === "tools" && (
        <ToolsPanel
          league={league}
          teams={teams}
          members={members}
          draft={draft}
        />
      )}
    </>
  );
}
