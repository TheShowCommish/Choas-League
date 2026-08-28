"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Team } from "@/lib/types";
import { setDraftOrder, type AdminResult } from "./actions";

/**
 * The draft order, set by hand.
 *
 * Up/down buttons rather than drag and drop: this is a list of twelve
 * that gets touched once a year, and drag and drop on a phone is a
 * fiddle for no gain.
 */
export function DraftOrderEditor({
  leagueId,
  teams,
  currentOrder,
}: {
  leagueId: string;
  teams: Team[];
  /** Team ids in draft order. Empty until an order has been set. */
  currentOrder: string[];
}) {
  const router = useRouter();
  const [result, setResult] = useState<AdminResult>({});
  const [pending, startTransition] = useTransition();

  // Anyone missing from a stored order goes on the end, so adding a team
  // to the league does not silently drop it out of the draft.
  const [order, setOrder] = useState<string[]>(() => {
    const known = currentOrder.filter((id) => teams.some((t) => t.id === id));
    const missing = teams
      .filter((t) => !known.includes(t.id))
      .map((t) => t.id);
    return [...known, ...missing];
  });

  const nameOf = new Map(teams.map((t) => [t.id, t.name]));

  function move(index: number, by: number) {
    const target = index + by;
    if (target < 0 || target >= order.length) return;
    setOrder((prev) => {
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function shuffle() {
    setOrder((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [next[i], next[j]] = [next[j], next[i]];
      }
      return next;
    });
  }

  function save() {
    startTransition(async () => {
      const outcome = await setDraftOrder(leagueId, order);
      setResult(outcome);
      if (!outcome.error) router.refresh();
    });
  }

  return (
    <section className="card space-y-3">
      <div>
        <h3 className="h2">Draft order</h3>
        <p className="muted text-sm">
          Pick one goes first. A snake draft reverses this every round.
          Saving rebuilds the board, so do it before draft night.
        </p>
      </div>

      <ol className="divide-y divide-border/60">
        {order.map((teamId, index) => (
          <li key={teamId} className="flex items-center gap-3 py-2">
            <span className="w-8 shrink-0 text-sm tabular-nums text-muted">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm">
              {nameOf.get(teamId) ?? "Unknown team"}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={index === 0 || pending}
              onClick={() => move(index, -1)}
              aria-label={`Move ${nameOf.get(teamId)} up`}
            >
              ↑
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={index === order.length - 1 || pending}
              onClick={() => move(index, 1)}
              aria-label={`Move ${nameOf.get(teamId)} down`}
            >
              ↓
            </button>
          </li>
        ))}
      </ol>

      {result.error && <p className="error-box">{result.error}</p>}
      {result.ok && <p className="ok-box">{result.ok}</p>}

      <div className="flex flex-wrap gap-2">
        <button
          className="btn btn-primary"
          disabled={pending}
          onClick={save}
        >
          {pending ? "Saving..." : "Save this order"}
        </button>
        <button className="btn" disabled={pending} onClick={shuffle}>
          Shuffle
        </button>
      </div>
    </section>
  );
}
