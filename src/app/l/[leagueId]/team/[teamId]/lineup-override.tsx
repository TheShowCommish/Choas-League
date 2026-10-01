"use client";

import { useActionState, useState } from "react";
import { positionLabel } from "@/lib/roster-slots";
import { overrideLineupSlot, type OverrideResult } from "./actions";

const empty: OverrideResult = {};

/** The "Move to" choice meaning "out of the lineup". The server wants "". */
const NO_SLOT = "__none__";

/**
 * Commissioner only: move one player in this team's lineup, even after
 * lock. Every move is written to the transaction log with the reason.
 *
 * Drawn as an admin panel -- dashed, tinted, badged -- so nobody reads
 * it as the manager's own controls. Both choices have to be made on
 * purpose: "Move to" starts blank rather than on "out of the lineup",
 * because a form that benches somebody when you forget a dropdown is a
 * bad form to give an override. The reason is required.
 */
export function LineupOverride({
  leagueId,
  teamId,
  teamName,
  week,
  players,
  slots,
}: {
  leagueId: string;
  teamId: string;
  teamName: string;
  week: number;
  players: {
    id: string;
    name: string;
    position: string | null;
    slotKey: string | null;
    locked: boolean;
  }[];
  slots: { key: string; label: string; isStarter: boolean }[];
}) {
  const [state, action, pending] = useActionState(overrideLineupSlot, empty);
  const [playerId, setPlayerId] = useState("");
  const [slotChoice, setSlotChoice] = useState("");

  const slotLabel = new Map(slots.map((s) => [s.key, s.label]));
  const starterKeys = new Set(
    slots.filter((s) => s.isStarter).map((s) => s.key),
  );
  const current = players.find((p) => p.id === playerId)?.slotKey ?? null;

  const starters = players.filter(
    (p) => p.slotKey && starterKeys.has(p.slotKey),
  );
  const others = players.filter(
    (p) => !p.slotKey || !starterKeys.has(p.slotKey),
  );

  const optionText = (p: (typeof players)[number]) =>
    [
      p.name,
      positionLabel(p.position),
      p.slotKey ? (slotLabel.get(p.slotKey) ?? p.slotKey) : "no slot",
      p.locked ? "locked" : null,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <section aria-labelledby="override-heading" className="admin-panel">
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge-admin">
          <ShieldIcon />
          Commissioner only
        </span>
        <h2 id="override-heading" className="h2">
          Fix {teamName}&apos;s week {week} lineup
        </h2>
      </div>
      <p className="muted text-sm">
        Moves one player, even after he is locked. The move and your reason
        are written to the league&apos;s transaction log.
      </p>

      <form action={action} className="space-y-3">
        <input type="hidden" name="league_id" value={leagueId} />
        <input type="hidden" name="team_id" value={teamId} />
        <input type="hidden" name="week" value={week} />
        <input
          type="hidden"
          name="slot_key"
          value={slotChoice === NO_SLOT ? "" : slotChoice}
        />

        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="label" htmlFor="override_player">
              Player
            </label>
            <select
              id="override_player"
              name="player_id"
              className="input"
              required
              value={playerId}
              onChange={(e) => {
                setPlayerId(e.target.value);
                setSlotChoice("");
              }}
            >
              <option value="" disabled>
                Choose a player
              </option>
              {starters.length > 0 && (
                <optgroup label="Starting">
                  {starters.map((p) => (
                    <option key={p.id} value={p.id}>
                      {optionText(p)}
                    </option>
                  ))}
                </optgroup>
              )}
              {others.length > 0 && (
                <optgroup label="Bench and reserve">
                  {others.map((p) => (
                    <option key={p.id} value={p.id}>
                      {optionText(p)}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="override_slot">
              Move to
            </label>
            <select
              id="override_slot"
              className="input"
              required
              disabled={!playerId}
              value={slotChoice}
              onChange={(e) => setSlotChoice(e.target.value)}
            >
              <option value="" disabled>
                {playerId ? "Choose a slot" : "Choose a player first"}
              </option>
              {slots.map((s) => (
                <option key={s.key} value={s.key} disabled={s.key === current}>
                  {s.label}
                  {s.key === current ? " (where he is now)" : ""}
                </option>
              ))}
              <option value={NO_SLOT} disabled={current === null}>
                Out of the lineup (no slot)
                {current === null ? " (where he is now)" : ""}
              </option>
            </select>
          </div>
        </div>

        <div>
          <label className="label" htmlFor="override_note">
            Reason <span className="font-normal">(required)</span>
          </label>
          <input
            id="override_note"
            name="note"
            className="input"
            required
            // At least one character that is not a space.
            pattern=".*\S.*"
            maxLength={200}
            placeholder="e.g. Site was down before kickoff"
            aria-describedby="override_note_hint"
          />
          <p id="override_note_hint" className="mt-1 text-xs text-muted">
            Every manager can read this in the transaction log.
          </p>
        </div>

        {state.error && (
          <p className="error-box" role="alert">
            {state.error}
          </p>
        )}
        {state.ok && (
          <p className="ok-box" role="status">
            {state.ok}
          </p>
        )}

        <button
          className="btn btn-primary w-full md:w-auto"
          // Left enabled: the required fields explain themselves when
          // it is pressed, where a faded button says nothing.
          disabled={pending}
        >
          {pending ? "Saving..." : "Move player and log it"}
        </button>
      </form>
    </section>
  );
}

function ShieldIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="size-3 shrink-0"
    >
      <path d="M8 1.75 2.75 3.75v4c0 3.1 2.2 5.4 5.25 6.5 3.05-1.1 5.25-3.4 5.25-6.5v-4L8 1.75Z" />
    </svg>
  );
}
