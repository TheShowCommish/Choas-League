"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Draft, DraftPick, Team } from "@/lib/types";
import type { DraftablePlayer } from "./page";
import { closeLot, nominatePlayer, placeBid } from "./actions";

export interface AuctionLot {
  id: string;
  player_id: string;
  nominated_by: string;
  high_bid: number;
  high_bidder_id: string | null;
  status: string;
  closes_at: string | null;
}

/**
 * The auction room.
 *
 * Everyone watches the same lot: one player up, a clock, and a high bid
 * that resets the clock every time it moves. Budgets are derived from
 * picks already won rather than stored, so they cannot drift.
 */
export function AuctionRoom({
  leagueId,
  draft,
  picks,
  teams,
  myTeamId,
  isCommissioner,
  available,
  openLot,
  nominatorId,
  budgets,
  maxBid,
  seasonLabel,
}: {
  leagueId: string;
  draft: Draft;
  picks: DraftPick[];
  teams: Team[];
  myTeamId: string | null;
  isCommissioner: boolean;
  available: DraftablePlayer[];
  openLot: AuctionLot | null;
  nominatorId: string | null;
  budgets: Record<string, number>;
  maxBid: number;
  seasonLabel: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [openingBid, setOpeningBid] = useState("1");

  const teamById = new Map(teams.map((t) => [t.id, t]));
  const nameById = new Map(available.map((p) => [p.player_id, p.full_name]));
  for (const pick of picks) {
    if (pick.player_id && !nameById.has(pick.player_id)) {
      nameById.set(pick.player_id, pick.player_id);
    }
  }

  const isMyNomination = nominatorId === myTeamId;
  const isLive = draft.status === "live";

  // --- realtime -------------------------------------------------------
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`auction-${draft.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "auction_lots", filter: `draft_id=eq.${draft.id}` },
        () => router.refresh(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "draft_picks", filter: `draft_id=eq.${draft.id}` },
        () => router.refresh(),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "drafts", filter: `id=eq.${draft.id}` },
        () => router.refresh(),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [draft.id, router]);

  // --- the clock ------------------------------------------------------
  const deadlineMs =
    isLive && openLot?.closes_at ? new Date(openLot.closes_at).getTime() : null;

  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (deadlineMs === null) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [deadlineMs]);

  const secondsLeft =
    deadlineMs === null
      ? null
      : Math.max(0, Math.ceil((deadlineMs - now) / 1000));

  useEffect(() => {
    if (secondsLeft !== 0 || !openLot) return;
    // The RPC re-checks the deadline, so browsers racing here is fine.
    void closeLot(leagueId, openLot.id).then(() => router.refresh());
  }, [secondsLeft, openLot, leagueId, router]);

  // --- actions --------------------------------------------------------
  function run(fn: () => Promise<{ error?: string; ok?: string }>) {
    setMessage(null);
    startTransition(async () => {
      const result = await fn();
      if (result.error) setMessage(result.error);
      router.refresh();
    });
  }

  const draftedIds = new Set(
    picks.filter((p) => p.player_id).map((p) => p.player_id as string),
  );
  const query = search.trim().toLowerCase();
  const nominatable = available
    .filter(
      (p) =>
        !draftedIds.has(p.player_id) &&
        p.player_id !== openLot?.player_id &&
        (!query || p.full_name.toLowerCase().includes(query)),
    )
    .slice(0, 60);

  const myBudget = myTeamId ? (budgets[myTeamId] ?? 0) : 0;

  return (
    <div className="space-y-4">
      <header className="card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="h1">{seasonLabel} Auction</h1>
            <p className="muted text-sm">
              {draft.rounds} roster spots &middot; ${draft.auction_budget}{" "}
              budget &middot; {draft.status}
            </p>
          </div>
          {myTeamId && (
            <div className="text-right">
              <p className="muted text-xs">Your budget</p>
              <p className="text-2xl font-semibold tabular-nums">${myBudget}</p>
              <p className="muted text-xs">max bid ${maxBid}</p>
            </div>
          )}
        </div>
        {message && <p className="error-box mt-3">{message}</p>}
      </header>

      {!isLive ? (
        <p className="card ok-box">
          {draft.status === "complete"
            ? "The auction is finished."
            : draft.status === "paused"
              ? "The auction is paused."
              : "The auction has not started yet. The commissioner opens it."}
        </p>
      ) : openLot ? (
        <LotCard
          lot={openLot}
          playerName={nameById.get(openLot.player_id) ?? openLot.player_id}
          highBidderName={
            openLot.high_bidder_id
              ? (teamById.get(openLot.high_bidder_id)?.name ?? "?")
              : null
          }
          secondsLeft={secondsLeft}
          canBid={
            !!myTeamId &&
            openLot.high_bidder_id !== myTeamId &&
            maxBid > openLot.high_bid
          }
          maxBid={maxBid}
          pending={pending}
          onBid={(amount) =>
            run(() => placeBid(leagueId, openLot.id, myTeamId!, amount))
          }
        />
      ) : (
        <section className="card space-y-3">
          <h2 className="h2">
            {nominatorId
              ? isMyNomination
                ? "Your nomination"
                : `Waiting on ${teamById.get(nominatorId)?.name ?? "someone"}`
              : "Nothing up for bid"}
          </h2>

          {(isMyNomination || isCommissioner) && (
            <>
              <div className="flex gap-2">
                <input
                  className="input flex-1"
                  placeholder="Search a player to nominate"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label="Search players"
                />
                <input
                  className="input w-24"
                  type="number"
                  min={1}
                  max={maxBid}
                  value={openingBid}
                  onChange={(e) => setOpeningBid(e.target.value)}
                  aria-label="Opening bid"
                />
              </div>

              <ul className="card-tight max-h-80 divide-y divide-border/60 overflow-y-auto">
                {nominatable.map((player) => (
                  <li
                    key={player.player_id}
                    className="flex items-center justify-between gap-3 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {player.full_name}
                      </p>
                      <p className="muted text-xs">
                        {player.pos ?? "?"} &middot; {player.team_abbr ?? "FA"}{" "}
                        &middot; {Number(player.total_points).toFixed(1)} pts
                      </p>
                    </div>
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={pending}
                      onClick={() =>
                        run(() =>
                          nominatePlayer(
                            leagueId,
                            draft.id,
                            player.player_id,
                            Number(openingBid) || 1,
                          ),
                        )
                      }
                    >
                      Nominate
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      <section className="card-tight">
        <h2 className="border-b border-border px-3 py-2 text-sm font-semibold">
          Budgets
        </h2>
        <ul className="divide-y divide-border/60">
          {teams.map((team) => {
            const spent = picks
              .filter((p) => p.team_id === team.id)
              .reduce((sum, p) => sum + (p.bid_amount ?? 0), 0);
            const filled = picks.filter((p) => p.team_id === team.id).length;

            return (
              <li
                key={team.id}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <span
                  className={`min-w-0 truncate ${
                    team.id === nominatorId ? "font-semibold text-accent" : ""
                  }`}
                >
                  {team.name}
                </span>
                <span className="muted shrink-0 tabular-nums">
                  ${budgets[team.id] ?? draft.auction_budget} left &middot;{" "}
                  {filled}/{draft.rounds} &middot; ${spent} spent
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="card-tight">
        <h2 className="border-b border-border px-3 py-2 text-sm font-semibold">
          Sold
        </h2>
        {picks.length === 0 ? (
          <p className="muted p-3 text-sm">Nothing sold yet.</p>
        ) : (
          <ul className="max-h-72 divide-y divide-border/60 overflow-y-auto">
            {[...picks].reverse().map((pick) => (
              <li key={pick.id} className="px-3 py-2 text-sm">
                <span className="font-medium">
                  {nameById.get(pick.player_id ?? "") ?? pick.player_id}
                </span>
                <span className="muted">
                  {" "}
                  &mdash; {teamById.get(pick.team_id)?.name} for $
                  {pick.bid_amount ?? 0}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function LotCard({
  lot,
  playerName,
  highBidderName,
  secondsLeft,
  canBid,
  maxBid,
  pending,
  onBid,
}: {
  lot: AuctionLot;
  playerName: string;
  highBidderName: string | null;
  secondsLeft: number | null;
  canBid: boolean;
  maxBid: number;
  pending: boolean;
  onBid: (amount: number) => void;
}) {
  const [custom, setCustom] = useState("");

  const increments = [1, 5, 10].map((step) => lot.high_bid + step);

  return (
    <section className="card space-y-4 border-accent">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="muted text-xs">On the block</p>
          <p className="truncate text-xl font-semibold">{playerName}</p>
          <p className="muted text-sm">
            ${lot.high_bid}
            {highBidderName && <> &middot; {highBidderName}</>}
          </p>
        </div>
        <div
          suppressHydrationWarning
          className={`text-4xl font-bold tabular-nums ${
            (secondsLeft ?? 99) <= 5 ? "text-negative" : ""
          }`}
        >
          {secondsLeft ?? "-"}
        </div>
      </div>

      {canBid ? (
        <div className="flex flex-wrap gap-2">
          {increments
            .filter((amount) => amount <= maxBid)
            .map((amount) => (
              <button
                key={amount}
                className="btn btn-primary"
                disabled={pending}
                onClick={() => onBid(amount)}
              >
                ${amount}
              </button>
            ))}

          <div className="flex gap-2">
            <input
              className="input w-24"
              type="number"
              min={lot.high_bid + 1}
              max={maxBid}
              placeholder="Custom"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              aria-label="Custom bid"
            />
            <button
              className="btn"
              disabled={pending || !custom}
              onClick={() => onBid(Number(custom))}
            >
              Bid
            </button>
          </div>
        </div>
      ) : (
        <p className="muted text-sm">
          {highBidderName ? "You hold the high bid." : "Waiting for bids."}
        </p>
      )}
    </section>
  );
}
