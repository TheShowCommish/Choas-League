"use client";

import { useState, useTransition } from "react";
import { addFreeAgent, placeWaiverClaim } from "./actions";

export interface DropOption {
  playerId: string;
  label: string;
}

/**
 * The add / claim control on each player row. A player sitting on
 * waivers cannot be added outright, so the button becomes a bid form.
 */
export function PlayerActions({
  leagueId,
  teamId,
  playerId,
  playerName,
  onWaivers,
  waiverType,
  faabRemaining,
  dropOptions,
}: {
  leagueId: string;
  teamId: string;
  playerId: string;
  playerName: string;
  onWaivers: boolean;
  waiverType: "faab" | "priority";
  faabRemaining: number;
  dropOptions: DropOption[];
}) {
  const [open, setOpen] = useState(false);
  const [bid, setBid] = useState("0");
  const [dropId, setDropId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      const drop = dropId || null;
      const result = onWaivers
        ? await placeWaiverClaim(leagueId, teamId, playerId, Number(bid), drop)
        : await addFreeAgent(leagueId, teamId, playerId, drop);

      if (result.error) {
        setMessage(result.error);
      } else {
        setMessage(null);
        setOpen(false);
      }
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn-sm btn-primary"
        onClick={() => setOpen(true)}
      >
        {onWaivers ? "Bid" : "Add"}
      </button>
    );
  }

  return (
    <div className="min-w-56 space-y-2 py-1">
      <p className="text-xs font-medium">{playerName}</p>

      {onWaivers && waiverType === "faab" && (
        <label className="block">
          <span className="muted text-xs">Bid (${faabRemaining} left)</span>
          <input
            className="input"
            type="number"
            min={0}
            max={faabRemaining}
            value={bid}
            onChange={(e) => setBid(e.target.value)}
          />
        </label>
      )}

      <label className="block">
        <span className="muted text-xs">Drop (optional)</span>
        <select
          className="input"
          value={dropId}
          onChange={(e) => setDropId(e.target.value)}
        >
          <option value="">Nobody</option>
          {dropOptions.map((d) => (
            <option key={d.playerId} value={d.playerId}>
              {d.label}
            </option>
          ))}
        </select>
      </label>

      {message && <p className="error-box text-xs">{message}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          className="btn btn-sm btn-primary flex-1"
          onClick={submit}
          disabled={pending}
        >
          {pending ? "..." : onWaivers ? "Place bid" : "Add"}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            setOpen(false);
            setMessage(null);
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
