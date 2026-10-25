"use client";

import { useRef, useState, useTransition } from "react";
import { addFreeAgent, placeWaiverClaim } from "./actions";

export interface DropOption {
  playerId: string;
  label: string;
}

/**
 * The add / claim control for a player. A player sitting on waivers cannot
 * be added outright, so the button becomes a bid form.
 *
 * Two layouts, one flow:
 *  - "dialog" (desktop table): the trigger opens a small centred modal, so
 *    the form never reflows the dense row or gets clipped by the table's
 *    own horizontal scroll container.
 *  - "inline" (mobile add sheet): the trigger expands the form in place
 *    inside the already-open bottom sheet, no nested dialogs.
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
  layout = "dialog",
}: {
  leagueId: string;
  teamId: string;
  playerId: string;
  playerName: string;
  onWaivers: boolean;
  waiverType: "faab" | "priority";
  faabRemaining: number;
  dropOptions: DropOption[];
  layout?: "dialog" | "inline";
}) {
  const [open, setOpen] = useState(false);
  const [bid, setBid] = useState("0");
  const [dropId, setDropId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const dialog = useRef<HTMLDialogElement>(null);

  const label = onWaivers ? "Bid" : "Add";

  function openForm() {
    setOpen(true);
    if (layout === "dialog") dialog.current?.showModal();
  }

  function closeForm() {
    setOpen(false);
    setMessage(null);
    if (layout === "dialog") dialog.current?.close();
  }

  function submit() {
    startTransition(async () => {
      const drop = dropId || null;
      const result = onWaivers
        ? await placeWaiverClaim(leagueId, teamId, playerId, Number(bid), drop)
        : await addFreeAgent(leagueId, teamId, playerId, drop);

      if (result.error) setMessage(result.error);
      else closeForm();
    });
  }

  const form = (
    <div className="space-y-3">
      {onWaivers && waiverType === "faab" && (
        <label className="block">
          <span className="label">Bid (${faabRemaining} left)</span>
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
        <span className="label">Drop (optional)</span>
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
          className="btn btn-primary flex-1"
          onClick={submit}
          disabled={pending}
        >
          {pending ? "..." : onWaivers ? "Place bid" : "Add player"}
        </button>
        {layout === "dialog" && (
          <button type="button" className="btn" onClick={closeForm}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );

  // Mobile: expand in place inside the add sheet.
  if (layout === "inline") {
    return (
      <div>
        <button
          type="button"
          className="btn btn-primary w-full"
          onClick={() => (open ? closeForm() : openForm())}
          aria-expanded={open}
        >
          {open ? "Cancel" : label}
        </button>
        {open && <div className="mt-3">{form}</div>}
      </div>
    );
  }

  // Desktop: a small centred modal, reusing the shared sheet recipe.
  return (
    <>
      <button
        type="button"
        className="btn btn-sm btn-primary"
        onClick={openForm}
        aria-haspopup="dialog"
      >
        {label}
      </button>

      <dialog
        ref={dialog}
        aria-label={`${label} ${playerName}`}
        onClose={() => {
          setOpen(false);
          setMessage(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            closeForm();
          }
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) closeForm();
        }}
        className="sheet mx-auto max-w-sm text-left sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border"
      >
        <div className="sheet-body">
          <div className="flex items-start justify-between gap-3 pb-3">
            <div className="min-w-0">
              <h2 className="h2 truncate">{playerName}</h2>
              <p className="muted text-xs">
                {onWaivers ? "Place a waiver claim" : "Add as a free agent"}
              </p>
            </div>
            <button
              type="button"
              onClick={closeForm}
              aria-label="Close"
              className="-mr-2 -mt-1 inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent"
            >
              <span aria-hidden className="text-xl leading-none">
                &times;
              </span>
            </button>
          </div>
          {form}
        </div>
      </dialog>
    </>
  );
}
