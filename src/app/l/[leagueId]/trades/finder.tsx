"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Team } from "@/lib/types";
import { findTrades, type ValuedPlayer } from "@/lib/trade-finder";
import { proposeTrade, setTradingBlock } from "./actions";

/**
 * The trade finder.
 *
 * Pick who you would part with, say how even you want the deal, and it
 * searches every other roster for a package worth about the same.
 *
 * The value model is weak on purpose and the page says so: a player's
 * own average so far, times the weeks left. It knows nothing about
 * schedule, injury, age or scarcity. Anything more elaborate would look
 * authoritative without being any more right, and the point of this
 * screen is to start a conversation, not to settle one.
 */
export function TradeFinder({
  leagueId,
  myTeam,
  teams,
  values,
  initialPartner,
}: {
  leagueId: string;
  myTeam: Team;
  teams: Team[];
  values: ValuedPlayer[];
  initialPartner: string | null;
}) {
  const router = useRouter();
  const [giving, setGiving] = useState<string[]>([]);
  const [tolerance, setTolerance] = useState(0.15);
  const [maxIncoming, setMaxIncoming] = useState(2);
  const [blockOnly, setBlockOnly] = useState(false);
  const [partner, setPartner] = useState<string>(initialPartner ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // No useMemo anywhere in here: the React Compiler memoizes these
  // itself, and hand-written memos on derived arrays defeat it.
  const teamName = new Map(teams.map((t) => [t.id, t.name]));

  const myPlayers = values
    .filter((v) => v.ownerTeamId === myTeam.id)
    .sort((a, b) => b.value - a.value);

  const give = myPlayers.filter((p) => giving.includes(p.playerId));

  const candidates = values.filter(
    (v) =>
      v.ownerTeamId !== myTeam.id &&
      (partner === "" || v.ownerTeamId === partner),
  );

  const suggestions = findTrades(give, candidates, {
    tolerance,
    maxIncoming,
    blockOnly,
  });

  function propose(receive: ValuedPlayer[], toTeamId: string) {
    setMessage(null);
    startTransition(async () => {
      const result = await proposeTrade(
        leagueId,
        myTeam.id,
        toTeamId,
        give.map((p) => p.playerId),
        receive.map((p) => p.playerId),
        0,
        "Found with the trade finder",
      );

      setMessage(result.error ?? "Proposal sent.");
      if (!result.error) router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <section className="card space-y-4">
        <div>
          <h2 className="h2">What would you give up?</h2>
          <p className="muted text-sm">
            Pick one or more of your own players.
          </p>
        </div>

        {myPlayers.length === 0 ? (
          <p className="muted text-sm">Your roster is empty.</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {myPlayers.map((player) => {
              const on = giving.includes(player.playerId);
              return (
                <li key={player.playerId}>
                  <button
                    type="button"
                    className={`card flex w-full items-center gap-3 text-left ${
                      on ? "border-accent" : "hover:border-accent"
                    }`}
                    onClick={() =>
                      setGiving((prev) =>
                        on
                          ? prev.filter((id) => id !== player.playerId)
                          : [...prev, player.playerId],
                      )
                    }
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {player.fullName}
                      </span>
                      <span className="muted block text-xs">
                        {player.position} &middot; {player.teamAbbr ?? "FA"}
                        {player.games === 0 && " · no games yet"}
                      </span>
                    </span>
                    <span className="shrink-0 text-sm tabular-nums">
                      {player.value.toFixed(0)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card space-y-4">
        <div>
          <label className="label" htmlFor="tolerance">
            How even should it be? Within {Math.round(tolerance * 100)}%
          </label>
          <input
            id="tolerance"
            type="range"
            min={0}
            max={50}
            step={1}
            value={Math.round(tolerance * 100)}
            onChange={(e) => setTolerance(Number(e.target.value) / 100)}
            className="w-full"
          />
          <div className="muted flex justify-between text-xs">
            <span>Dead even</span>
            <span>Anything close-ish</span>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="partner">
              Trade with
            </label>
            <select
              id="partner"
              className="input"
              value={partner}
              onChange={(e) => setPartner(e.target.value)}
            >
              <option value="">Anyone</option>
              {teams
                .filter((t) => t.id !== myTeam.id)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="incoming">
              Players back
            </label>
            <select
              id="incoming"
              className="input"
              value={maxIncoming}
              onChange={(e) => setMaxIncoming(Number(e.target.value))}
            >
              <option value={1}>One only</option>
              <option value={2}>One or two</option>
            </select>
          </div>

          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={blockOnly}
                onChange={(e) => setBlockOnly(e.target.checked)}
              />
              Only players on the block
            </label>
          </div>
        </div>
      </section>

      {message && (
        <p className={message === "Proposal sent." ? "ok-box" : "error-box"}>
          {message}
        </p>
      )}

      {give.length === 0 ? (
        <p className="card muted">Choose someone to offer.</p>
      ) : suggestions.length === 0 ? (
        <p className="card muted">
          Nothing within {Math.round(tolerance * 100)}%. Widen the slider, or
          offer a different package.
        </p>
      ) : (
        <ul className="space-y-2">
          {suggestions.map((suggestion, index) => (
            <li key={index} className="card space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium">
                  {teamName.get(suggestion.teamId) ?? "Another team"}
                </span>
                <span
                  className={`text-xs ${
                    suggestion.difference >= 0
                      ? "text-positive"
                      : "text-negative"
                  }`}
                >
                  {suggestion.difference >= 0 ? "+" : ""}
                  {suggestion.difference} for you &middot;{" "}
                  {Math.round(suggestion.imbalance * 100)}% apart
                </span>
              </div>

              <p className="text-sm">
                <span className="muted">You get </span>
                {suggestion.receive.map((p) => p.fullName).join(" + ")}
                <span className="muted"> for </span>
                {suggestion.give.map((p) => p.fullName).join(" + ")}
              </p>

              <p className="muted text-xs">
                {suggestion.receiveValue} against {suggestion.giveValue}{" "}
                expected points over the rest of the season
              </p>

              <button
                className="btn btn-sm btn-primary"
                disabled={pending}
                onClick={() => propose(suggestion.receive, suggestion.teamId)}
              >
                Propose this
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The league-wide trading block, plus toggles for your own players. */
export function TradingBlock({
  leagueId,
  myTeam,
  teams,
  values,
}: {
  leagueId: string;
  myTeam: Team | null;
  teams: Team[];
  values: ValuedPlayer[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const teamName = new Map(teams.map((t) => [t.id, t.name]));

  const listed = values
    .filter((v) => v.onBlock)
    .sort((a, b) => b.value - a.value);

  const mine = myTeam
    ? values
        .filter((v) => v.ownerTeamId === myTeam.id)
        .sort((a, b) => b.value - a.value)
    : [];

  function toggle(playerId: string, on: boolean) {
    if (!myTeam) return;
    startTransition(async () => {
      await setTradingBlock(leagueId, myTeam.id, playerId, on);
      router.refresh();
    });
  }

  return (
    <div className="space-y-5">
      <section>
        <h2 className="h2 mb-2">On the block</h2>
        {listed.length === 0 ? (
          <p className="card muted">
            Nobody is listed. Put one of yours up below and the rest of the
            league will see it here.
          </p>
        ) : (
          <ul className="card-tight divide-y divide-border/60">
            {listed.map((player) => (
              <li
                key={player.playerId}
                className="flex items-center gap-3 p-3"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {player.fullName}
                  </span>
                  <span className="muted block text-xs">
                    {player.position} &middot; {player.teamAbbr ?? "FA"}{" "}
                    &middot; {teamName.get(player.ownerTeamId) ?? "?"}
                  </span>
                </span>
                <span className="shrink-0 text-sm tabular-nums">
                  {player.value.toFixed(0)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {myTeam && mine.length > 0 && (
        <section>
          <h2 className="h2 mb-2">Your roster</h2>
          <p className="muted mb-2 text-sm">
            Listing a player is a signal, not a commitment. Nothing moves
            without a proposal you accept.
          </p>
          <ul className="card-tight divide-y divide-border/60">
            {mine.map((player) => (
              <li
                key={player.playerId}
                className="flex items-center gap-3 p-3"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {player.fullName}
                  </span>
                  <span className="muted block text-xs">
                    {player.position} &middot; {player.teamAbbr ?? "FA"}
                  </span>
                </span>
                <button
                  type="button"
                  className={`btn btn-sm shrink-0 ${
                    player.onBlock ? "btn-primary" : ""
                  }`}
                  disabled={pending}
                  onClick={() => toggle(player.playerId, !player.onBlock)}
                >
                  {player.onBlock ? "Listed" : "List"}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
