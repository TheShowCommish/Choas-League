"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Team, Trade } from "@/lib/types";
import type { TradeItemRow } from "./page";
import { acceptTrade, respondToTrade } from "./actions";

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
}: {
  leagueId: string;
  trades: Trade[];
  items: TradeItemRow[];
  teams: Team[];
  myTeamId: string | null;
  playerNames: Record<string, string>;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const teamName = (id: string) =>
    teams.find((t) => t.id === id)?.name ?? "Unknown team";

  const itemsFor = (tradeId: string) =>
    items.filter((i) => i.trade_id === tradeId);

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
          if (own.length === 0) return "nothing";
          return own
            .map((i) =>
              i.faab_amount != null
                ? `$${i.faab_amount} FAAB`
                : (playerNames[i.player_id!] ?? i.player_id),
            )
            .join(", ");
        };

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

            <dl className="space-y-1 text-sm">
              <div className="flex gap-2">
                <dt className="muted w-32 shrink-0">
                  {teamName(trade.proposing_team_id)} sends
                </dt>
                <dd>{describe(trade.proposing_team_id)}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="muted w-32 shrink-0">
                  {teamName(trade.receiving_team_id)} sends
                </dt>
                <dd>{describe(trade.receiving_team_id)}</dd>
              </div>
            </dl>

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
