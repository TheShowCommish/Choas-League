"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Team, Trade } from "@/lib/types";
import type { TradeImpact } from "@/lib/trade-impact";
import type { TradeItemRow } from "./page";
import { acceptTrade, respondToTrade } from "./actions";
import { PlayerValue, TradeImpactBlock } from "./trade-impact-view";

const STATUS_LABEL: Record<Trade["status"], string> = {
  pending: "Pending",
  accepted: "Accepted",
  rejected: "Rejected",
  cancelled: "Cancelled",
  vetoed: "Vetoed",
  completed: "Completed",
};

export function TradeList({
  leagueId,
  trades,
  items,
  teams,
  myTeamId,
  playerNames,
  playerValues,
  impacts,
}: {
  leagueId: string;
  trades: Trade[];
  items: TradeItemRow[];
  teams: Team[];
  myTeamId: string | null;
  playerNames: Record<string, string>;
  playerValues: Record<string, { avg: number; projection: number | null }>;
  impacts: Record<string, TradeImpact>;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const teamName = (id: string) =>
    teams.find((t) => t.id === id)?.name ?? "Unknown team";

  const itemsFor = (tradeId: string) =>
    items.filter((i) => i.trade_id === tradeId);

  // A player's name on its own line with his decision-support value beneath
  // (T-073): season average primary, next-week projection muted. On its own
  // row so a long name plus its numbers never force a sideways scroll.
  const playerLine = (id: string) => {
    const name = playerNames[id] ?? id;
    const v = playerValues[id];
    return (
      <p key={id} className="leading-snug">
        <span>{name}</span>
        {v && (
          <PlayerValue
            avg={v.avg}
            projection={v.projection}
            className="ml-2 text-xs"
          />
        )}
      </p>
    );
  };

  function act(fn: () => Promise<{ error?: string; ok?: string }>) {
    setMessage(null);
    startTransition(async () => {
      const result = await fn();
      setMessage(result.error ?? result.ok ?? null);
      router.refresh();
    });
  }

  if (trades.length === 0) {
    return <p className="card muted">No trades yet.</p>;
  }

  return (
    <section className="space-y-3">
      {message && <p className="ok-box">{message}</p>}

      {trades.map((trade) => {
        const tradeItems = itemsFor(trade.id);
        const fromMe = trade.proposing_team_id === myTeamId;
        const toMe = trade.receiving_team_id === myTeamId;
        const isPending = trade.status === "pending";

        const describe = (teamId: string) => {
          const own = tradeItems.filter((i) => i.from_team_id === teamId);
          if (own.length === 0) return <span className="muted">nothing</span>;
          return (
            <div className="space-y-1">
              {own.map((i) =>
                i.faab_amount != null ? (
                  <p key={i.id} className="tabular-nums">
                    ${i.faab_amount} FAAB
                  </p>
                ) : (
                  playerLine(i.player_id!)
                ),
              )}
            </div>
          );
        };

        const impact = impacts[trade.id];

        return (
          <article
            key={trade.id}
            className={`card ${isPending && toMe ? "border-accent" : ""}`}
          >
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="text-sm font-medium">
                {teamName(trade.proposing_team_id)} &rarr;{" "}
                {teamName(trade.receiving_team_id)}
              </span>
              <span
                className={`pill ${
                  trade.status === "completed"
                    ? "border-positive/50 text-positive"
                    : isPending
                      ? "border-accent/50 text-accent"
                      : ""
                }`}
              >
                {STATUS_LABEL[trade.status]}
              </span>
            </div>

            <dl className="space-y-2 text-sm md:space-y-1">
              <div className="flex flex-col gap-0.5 md:flex-row md:gap-2">
                <dt className="muted shrink-0 md:w-36">
                  {teamName(trade.proposing_team_id)} sends
                </dt>
                <dd className="min-w-0">{describe(trade.proposing_team_id)}</dd>
              </div>
              <div className="flex flex-col gap-0.5 md:flex-row md:gap-2">
                <dt className="muted shrink-0 md:w-36">
                  {teamName(trade.receiving_team_id)} sends
                </dt>
                <dd className="min-w-0">{describe(trade.receiving_team_id)}</dd>
              </div>
            </dl>

            {/* The trade preview (T-073): each side's best starting lineup
                before and after, and any legality warning. Shown for pending
                trades, where the current rosters still make it meaningful.
                Shared look with the propose screen via TradeImpactBlock. */}
            {impact && (
              <TradeImpactBlock
                proposingName={teamName(trade.proposing_team_id)}
                receivingName={teamName(trade.receiving_team_id)}
                impact={impact}
                className="mt-3 border-t border-border/60 pt-3"
              />
            )}

            {trade.note && (
              <p className="muted mt-2 text-sm italic">
                &ldquo;{trade.note}&rdquo;
              </p>
            )}

            {isPending && (toMe || fromMe) && (
              <div className="mt-3 flex flex-wrap gap-2">
                {toMe && (
                  <>
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={pending}
                      onClick={() => act(() => acceptTrade(leagueId, trade.id))}
                    >
                      Accept
                    </button>
                    <button
                      className="btn btn-sm"
                      disabled={pending}
                      onClick={() =>
                        act(() =>
                          respondToTrade(leagueId, trade.id, "rejected"),
                        )
                      }
                    >
                      Reject
                    </button>
                  </>
                )}
                {fromMe && (
                  <button
                    className="btn btn-sm"
                    disabled={pending}
                    onClick={() =>
                      act(() => respondToTrade(leagueId, trade.id, "cancelled"))
                    }
                  >
                    Withdraw
                  </button>
                )}
              </div>
            )}

            <p className="muted mt-2 text-xs">
              Week {trade.week} &middot;{" "}
              {new Date(trade.created_at).toLocaleDateString()}
            </p>
          </article>
        );
      })}
    </section>
  );
}
