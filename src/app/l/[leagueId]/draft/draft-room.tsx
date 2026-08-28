"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Draft, DraftPick, Team } from "@/lib/types";
import type { DraftablePlayer } from "./page";
import { makePick, queuePlayer, runAutopick, unqueuePlayer } from "./actions";

/**
 * The draft room.
 *
 * Every browser in the room subscribes to draft_picks and drafts over
 * realtime, so a pick made anywhere refreshes everyone's board. The
 * clock is rendered from the server's pick_deadline rather than a local
 * countdown, so a slow phone and a fast laptop agree on the time left.
 */
export function DraftRoom({
  leagueId,
  draft,
  picks,
  teams,
  myTeamId,
  isCommissioner,
  available,
  queuedIds,
  seasonLabel,
}: {
  leagueId: string;
  draft: Draft;
  picks: DraftPick[];
  teams: Team[];
  myTeamId: string | null;
  isCommissioner: boolean;
  available: DraftablePlayer[];
  queuedIds: string[];
  seasonLabel: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [position, setPosition] = useState("");
  const [queued, setQueued] = useState<string[]>(queuedIds);

  const teamById = useMemo(
    () => new Map(teams.map((t) => [t.id, t])),
    [teams],
  );

  const currentPick = picks.find(
    (p) => p.pick_number === draft.current_pick_number,
  );
  const onTheClock = currentPick ? teamById.get(currentPick.team_id) : null;
  const isMyPick = currentPick?.team_id === myTeamId;
  const canPick =
    draft.status === "live" && (isMyPick || isCommissioner) && !!currentPick;

  // --- realtime -------------------------------------------------------
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`draft-${draft.id}`)
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
  // Only `now` is state, and it is written solely from the interval
  // callback -- deriving the countdown during render avoids the
  // cascading re-render an effect-driven counter would cause.
  const deadlineMs =
    draft.status === "live" && draft.pick_deadline
      ? new Date(draft.pick_deadline).getTime()
      : null;

  const [now, setNow] = useState(() => Date.now());
  const autopickFired = useRef(false);

  useEffect(() => {
    autopickFired.current = false;
    if (deadlineMs === null) return;

    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [deadlineMs]);

  const secondsLeft =
    deadlineMs === null
      ? null
      : Math.max(0, Math.round((deadlineMs - now) / 1000));

  useEffect(() => {
    if (secondsLeft !== 0 || !draft.autopick_enabled) return;
    if (autopickFired.current) return;

    // Whoever has the room open nudges the server. The RPC re-checks the
    // deadline itself, so several browsers racing here is harmless.
    autopickFired.current = true;
    void runAutopick(leagueId, draft.id).then(() => router.refresh());
  }, [secondsLeft, draft.autopick_enabled, draft.id, leagueId, router]);

  // --- actions --------------------------------------------------------
  const pick = useCallback(
    (playerId: string, playerName: string) => {
      if (!confirm(`Draft ${playerName}?`)) return;
      startTransition(async () => {
        const result = await makePick(leagueId, draft.id, playerId);
        setError(result.error ?? null);
        router.refresh();
      });
    },
    [leagueId, draft.id, router],
  );

  function toggleQueue(playerId: string) {
    if (!myTeamId) return;
    startTransition(async () => {
      if (queued.includes(playerId)) {
        await unqueuePlayer(myTeamId, playerId);
        setQueued((prev) => prev.filter((id) => id !== playerId));
      } else {
        await queuePlayer(myTeamId, playerId, queued.length + 1);
        setQueued((prev) => [...prev, playerId]);
      }
    });
  }

  // --- derived lists --------------------------------------------------
  const draftedIds = new Set(
    picks.filter((p) => p.player_id).map((p) => p.player_id as string),
  );

  const query = search.trim().toLowerCase();
  const filtered = available.filter(
    (p) =>
      !draftedIds.has(p.player_id) &&
      (!position || p.pos === position) &&
      (!query || p.full_name.toLowerCase().includes(query)),
  );

  const positions = [...new Set(available.map((p) => p.pos).filter(Boolean))];
  const recentPicks = picks
    .filter((p) => p.player_id)
    .slice(-8)
    .reverse();

  const myPicks = picks.filter((p) => p.team_id === myTeamId && p.player_id);
  const nameById = new Map(available.map((p) => [p.player_id, p.full_name]));

  return (
    <div className="space-y-4">
      <header className="card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="h1">{seasonLabel} Draft</h1>
            <p className="muted text-sm">
              {draft.type === "snake" ? "Snake" : "Auction"} &middot;{" "}
              {draft.rounds} rounds &middot; {draft.status}
            </p>
          </div>

          {draft.status === "live" && secondsLeft !== null && (
            <div
              suppressHydrationWarning
              className={`text-3xl font-bold tabular-nums ${
                secondsLeft <= 10 ? "text-negative" : ""
              }`}
            >
              {Math.floor(secondsLeft / 60)}:
              {String(secondsLeft % 60).padStart(2, "0")}
            </div>
          )}
        </div>

        {draft.status !== "live" ? (
          <p className="ok-box mt-3">
            {draft.status === "complete"
              ? "The draft is finished."
              : draft.status === "paused"
                ? "The draft is paused."
                : "The draft has not started yet. The commissioner opens it."}
          </p>
        ) : currentPick ? (
          <p className={`mt-3 ${isMyPick ? "ok-box" : "muted"}`}>
            Pick {currentPick.pick_number} &middot; round {currentPick.round} —{" "}
            <strong>
              {isMyPick ? "You are on the clock" : onTheClock?.name}
            </strong>
          </p>
        ) : null}

        {error && <p className="error-box mt-3">{error}</p>}
      </header>

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <section className="space-y-3">
          <div className="card flex flex-wrap gap-2">
            <input
              className="input flex-1"
              placeholder="Search players"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search players"
            />
            <select
              className="input w-32"
              value={position}
              onChange={(e) => setPosition(e.target.value)}
              aria-label="Position"
            >
              <option value="">All</option>
              {positions.map((p) => (
                <option key={p} value={p!}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          <div className="card-tight table-scroll max-h-[60vh] overflow-y-auto">
            <table className="table">
              <thead className="sticky top-0 bg-surface">
                <tr>
                  <th>Player</th>
                  <th className="text-right">Pts</th>
                  <th className="w-32" />
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={3} className="muted py-6 text-center">
                      Nobody left matching that.
                    </td>
                  </tr>
                )}
                {filtered.map((player) => (
                  <tr key={player.player_id}>
                    <td>
                      <span className="block font-medium">
                        {player.full_name}
                      </span>
                      <span className="muted text-xs">
                        {player.pos ?? "?"} &middot;{" "}
                        {player.team_abbr ?? "FA"}
                      </span>
                    </td>
                    <td className="text-right tabular-nums">
                      {Number(player.total_points).toFixed(1)}
                    </td>
                    <td>
                      <div className="flex gap-1">
                        {myTeamId && (
                          <button
                            type="button"
                            className={`btn btn-sm ${
                              queued.includes(player.player_id)
                                ? "btn-primary"
                                : ""
                            }`}
                            disabled={pending}
                            onClick={() => toggleQueue(player.player_id)}
                            title="Add to your queue (used by autopick)"
                          >
                            {queued.includes(player.player_id) ? "★" : "☆"}
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          disabled={!canPick || pending}
                          onClick={() =>
                            pick(player.player_id, player.full_name)
                          }
                        >
                          Draft
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="space-y-4">
          <section className="card-tight">
            <h2 className="border-b border-border px-3 py-2 text-sm font-semibold">
              Recent picks
            </h2>
            {recentPicks.length === 0 ? (
              <p className="muted p-3 text-sm">No picks yet.</p>
            ) : (
              <ul className="divide-y divide-border/60">
                {recentPicks.map((p) => (
                  <li key={p.id} className="px-3 py-2 text-sm">
                    <span className="muted text-xs">
                      {p.round}.{String(p.round_pick).padStart(2, "0")}
                    </span>{" "}
                    <span className="font-medium">
                      {nameById.get(p.player_id!) ?? p.player_id}
                    </span>
                    <span className="muted block text-xs">
                      {teamById.get(p.team_id)?.name}
                      {p.is_autopick && " · auto"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {myTeamId && (
            <section className="card-tight">
              <h2 className="border-b border-border px-3 py-2 text-sm font-semibold">
                Your picks ({myPicks.length})
              </h2>
              {myPicks.length === 0 ? (
                <p className="muted p-3 text-sm">Nothing yet.</p>
              ) : (
                <ul className="divide-y divide-border/60">
                  {myPicks.map((p) => (
                    <li key={p.id} className="px-3 py-2 text-sm">
                      <span className="muted text-xs">R{p.round}</span>{" "}
                      {nameById.get(p.player_id!) ?? p.player_id}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <DraftBoard picks={picks} teams={teams} nameById={nameById} />
        </aside>
      </div>
    </div>
  );
}

/** The full grid: one column per team, one row per round. */
function DraftBoard({
  picks,
  teams,
  nameById,
}: {
  picks: DraftPick[];
  teams: Team[];
  nameById: Map<string, string>;
}) {
  const rounds = [...new Set(picks.map((p) => p.round))].sort((a, b) => a - b);
  const teamById = new Map(teams.map((t) => [t.id, t]));

  if (rounds.length === 0) return null;

  return (
    <details className="card-tight">
      <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">
        Full board
      </summary>
      <div className="table-scroll max-h-96 overflow-y-auto">
        <table className="table">
          <tbody>
            {rounds.map((round) => (
              <tr key={round}>
                <td className="muted text-xs">R{round}</td>
                {picks
                  .filter((p) => p.round === round)
                  .map((p) => (
                    <td key={p.id} className="text-xs whitespace-nowrap">
                      {p.player_id ? (
                        nameById.get(p.player_id) ?? p.player_id
                      ) : (
                        <span className="muted">
                          {teamById.get(p.team_id)?.abbreviation ||
                            teamById.get(p.team_id)?.name.slice(0, 8)}
                        </span>
                      )}
                    </td>
                  ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
