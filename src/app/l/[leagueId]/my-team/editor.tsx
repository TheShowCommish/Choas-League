"use client";

import { useActionState, useMemo, useState, useTransition } from "react";
import type { RosterEntry } from "@/lib/roster";
import type { RosterSlot } from "@/lib/types";
import { expandSlots, slotAccepts } from "@/lib/roster-slots";
import { saveLineup, dropPlayerById, type LineupResult } from "./actions";

const empty: LineupResult = {};

/**
 * The lineup, as a board of slots rather than a list of players.
 *
 * Every slot the league defines is drawn whether or not anyone is in it,
 * so an empty QB spot on Sunday morning is obvious. Moving a player is a
 * swap: pick a slot, choose who should be in it, and whoever was there
 * takes the incomer's place. That is the same gesture whether you are
 * filling an empty slot, benching a starter or swapping two starters,
 * which is why there is no separate "bench" or "start" action.
 */
export function LineupEditor({
  leagueId,
  teamId,
  season,
  week,
  slots,
  roster,
}: {
  leagueId: string;
  teamId: string;
  season: number;
  week: number;
  slots: RosterSlot[];
  roster: RosterEntry[];
}) {
  const [state, action, pending] = useActionState(saveLineup, empty);

  const byPlayer = useMemo(
    () => new Map(roster.map((r) => [r.playerId, r])),
    [roster],
  );

  /** Every individual spot in the league's roster, in order. */
  const spots = useMemo(() => expandSlots(slots), [slots]);

  /**
   * spot key -> player id. Seeded from the saved lineup: players are
   * dealt into the spots matching the slot they were saved into.
   */
  const [placed, setPlaced] = useState<Record<string, string | null>>(() => {
    const next: Record<string, string | null> = {};
    const remaining = new Map<string, string[]>();

    for (const entry of roster) {
      if (!entry.slotKey) continue;
      const list = remaining.get(entry.slotKey) ?? [];
      list.push(entry.playerId);
      remaining.set(entry.slotKey, list);
    }

    for (const spot of spots) {
      next[spot.key] = remaining.get(spot.slotKey)?.shift() ?? null;
    }
    return next;
  });

  const [openSpot, setOpenSpot] = useState<string | null>(null);

  const placedIds = new Set(
    Object.values(placed).filter((id): id is string => id !== null),
  );
  const unassigned = roster.filter((r) => !placedIds.has(r.playerId));

  /** Where a player is sitting right now, if anywhere. */
  function spotOf(playerId: string): string | null {
    return (
      Object.entries(placed).find(([, id]) => id === playerId)?.[0] ?? null
    );
  }

  /**
   * Puts `playerId` in `spotKey`, moving whoever was there to wherever
   * the incoming player came from. If he came from the unassigned pool,
   * the outgoing player joins it.
   */
  function put(spotKey: string, playerId: string | null) {
    setPlaced((prev) => {
      const next = { ...prev };
      const displaced = next[spotKey] ?? null;

      if (playerId === null) {
        next[spotKey] = null;
        return next;
      }

      const from = Object.entries(prev).find(([, id]) => id === playerId)?.[0];
      next[spotKey] = playerId;
      if (from && from !== spotKey) next[from] = displaced;

      return next;
    });
    setOpenSpot(null);
  }

  const starterSpots = spots.filter((s) => s.isStarter);

  const projectedTotal = starterSpots.reduce((sum, spot) => {
    const id = placed[spot.key];
    return sum + (id ? (byPlayer.get(id)?.points ?? 0) : 0);
  }, 0);

  const emptyStarters = starterSpots.filter((s) => !placed[s.key]).length;

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="league_id" value={leagueId} />
      <input type="hidden" name="team_id" value={teamId} />
      <input type="hidden" name="season" value={season} />
      <input type="hidden" name="week" value={week} />

      {/* One field per player, carrying the slot he ended up in. The
          server contract is unchanged: an empty value means "not in the
          lineup this week". */}
      {roster.map((entry) => (
        <input
          key={entry.playerId}
          type="hidden"
          name={`slot__${entry.playerId}`}
          value={
            spots.find((s) => placed[s.key] === entry.playerId)?.slotKey ?? ""
          }
        />
      ))}

      <div className="card flex flex-wrap items-center gap-3">
        <span className="pill">
          Starters {starterSpots.length - emptyStarters}/{starterSpots.length}
        </span>
        {emptyStarters > 0 && (
          <span className="pill border-negative text-negative">
            {emptyStarters} empty
          </span>
        )}
        <span className="pill ml-auto">{projectedTotal.toFixed(1)} pts</span>
      </div>

      <SpotList
        title="Starters"
        spots={spots.filter((s) => s.isStarter)}
        placed={placed}
        byPlayer={byPlayer}
        openSpot={openSpot}
        setOpenSpot={setOpenSpot}
        roster={roster}
        spotOf={spotOf}
        put={put}
        leagueId={leagueId}
        teamId={teamId}
      />

      <SpotList
        title="Bench and reserve"
        spots={spots.filter((s) => !s.isStarter)}
        placed={placed}
        byPlayer={byPlayer}
        openSpot={openSpot}
        setOpenSpot={setOpenSpot}
        roster={roster}
        spotOf={spotOf}
        put={put}
        leagueId={leagueId}
        teamId={teamId}
      />

      {unassigned.length > 0 && (
        <section>
          <h2 className="h2 mb-2">Not in the lineup</h2>
          <p className="muted mb-2 text-sm">
            More players than spots. These score nothing until you find them
            somewhere to sit.
          </p>
          <ul className="card-tight divide-y divide-border/60">
            {unassigned.map((entry) => (
              <li key={entry.playerId} className="flex items-center gap-3 p-3">
                <PlayerLine entry={entry} />
                <DropButton
                  leagueId={leagueId}
                  teamId={teamId}
                  playerId={entry.playerId}
                  playerName={entry.player.full_name}
                  disabled={entry.locked}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {state.error && <p className="error-box">{state.error}</p>}
      {state.ok && <p className="ok-box">{state.ok}</p>}

      <button className="btn btn-primary w-full md:w-auto" disabled={pending}>
        {pending ? "Saving..." : `Save week ${week} lineup`}
      </button>
    </form>
  );
}

interface Spot {
  key: string;
  slotKey: string;
  label: string;
  isStarter: boolean;
  eligiblePositions: string[];
}

function SpotList({
  title,
  spots,
  placed,
  byPlayer,
  openSpot,
  setOpenSpot,
  roster,
  spotOf,
  put,
  leagueId,
  teamId,
}: {
  title: string;
  spots: Spot[];
  placed: Record<string, string | null>;
  byPlayer: Map<string, RosterEntry>;
  openSpot: string | null;
  setOpenSpot: (key: string | null) => void;
  roster: RosterEntry[];
  spotOf: (playerId: string) => string | null;
  put: (spotKey: string, playerId: string | null) => void;
  leagueId: string;
  teamId: string;
}) {
  if (spots.length === 0) return null;

  return (
    <section>
      <h2 className="h2 mb-2">{title}</h2>
      <ul className="card-tight divide-y divide-border/60">
        {spots.map((spot) => {
          const playerId = placed[spot.key];
          const entry = playerId ? byPlayer.get(playerId) : undefined;
          const locked = entry?.locked ?? false;
          const isOpen = openSpot === spot.key;

          // Anyone eligible for this spot who is not locked in place.
          const candidates = roster.filter(
            (r) =>
              r.playerId !== playerId &&
              !r.locked &&
              slotAccepts(
                { eligible_positions: spot.eligiblePositions },
                r.player.position,
              ),
          );

          return (
            <li key={spot.key} className="p-3">
              <div className="flex items-center gap-3">
                <span className="w-14 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted">
                  {spot.label}
                </span>

                {entry ? (
                  <PlayerLine entry={entry} />
                ) : (
                  <span className="muted flex-1 text-sm italic">Empty</span>
                )}

                <button
                  type="button"
                  className="btn btn-sm shrink-0"
                  disabled={locked}
                  title={
                    locked ? "This game has kicked off" : `Change ${spot.label}`
                  }
                  onClick={() => setOpenSpot(isOpen ? null : spot.key)}
                >
                  {locked ? "Locked" : entry ? "Swap" : "Fill"}
                </button>

                {entry && (
                  <DropButton
                    leagueId={leagueId}
                    teamId={teamId}
                    playerId={entry.playerId}
                    playerName={entry.player.full_name}
                    disabled={locked}
                  />
                )}
              </div>

              {isOpen && (
                <div className="mt-3 rounded-lg border border-border bg-surface p-2">
                  {entry && (
                    <button
                      type="button"
                      className="btn btn-sm mb-2 w-full"
                      onClick={() => put(spot.key, null)}
                    >
                      Leave {spot.label} empty
                    </button>
                  )}

                  {candidates.length === 0 ? (
                    <p className="muted p-2 text-sm">
                      Nobody else on your roster can play here.
                    </p>
                  ) : (
                    <ul className="max-h-72 divide-y divide-border/60 overflow-y-auto">
                      {candidates.map((candidate) => {
                        const from = spotOf(candidate.playerId);
                        return (
                          <li key={candidate.playerId}>
                            <button
                              type="button"
                              className="flex w-full items-center gap-3 p-2 text-left hover:bg-bg"
                              onClick={() => put(spot.key, candidate.playerId)}
                            >
                              <PlayerLine entry={candidate} />
                              <span className="muted shrink-0 text-xs">
                                {from ? "swap" : "add"}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PlayerLine({ entry }: { entry: RosterEntry }) {
  const onBye = entry.game === null;

  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm font-medium">
        {entry.player.full_name}
      </span>
      <span className="muted block truncate text-xs">
        {entry.player.position ?? "?"} &middot; {entry.player.team_abbr ?? "FA"}
        {onBye ? (
          <span className="text-negative"> &middot; BYE</span>
        ) : (
          <> &middot; {entry.opponent}</>
        )}
        {" · "}
        {entry.points.toFixed(1)} pts
        {!entry.isFinal && entry.points !== 0 && " *"}
      </span>
    </span>
  );
}

/**
 * Calls the drop action directly rather than submitting a form: these
 * buttons sit inside the lineup form, and a form per row is not an
 * option (nested forms are invalid HTML) while a shared set of hidden
 * inputs would collide on field names.
 */
function DropButton({
  leagueId,
  teamId,
  playerId,
  playerName,
  disabled,
}: {
  leagueId: string;
  teamId: string;
  playerId: string;
  playerName: string;
  disabled: boolean;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      className="btn btn-sm btn-danger shrink-0"
      disabled={disabled || pending}
      title={`Drop ${playerName}`}
      onClick={() => {
        if (!confirm(`Drop ${playerName}? He goes on waivers.`)) return;
        startTransition(async () => {
          const result = await dropPlayerById(leagueId, teamId, playerId);
          if (result.error) alert(result.error);
        });
      }}
    >
      Drop
    </button>
  );
}
