"use client";

import { useActionState, useState } from "react";
import type { RosterSlot } from "@/lib/types";
import { saveRosterSlots, type AdminResult } from "./actions";

const empty: AdminResult = {};

/** Positions a slot can be restricted to. Empty selection = any position. */
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF", "DL", "LB", "DB"];

interface SlotDraft {
  slot_key: string;
  label: string;
  eligible_positions: string[];
  count: number;
  is_starter: boolean;
}

export function RosterPanel({
  leagueId,
  slots,
}: {
  leagueId: string;
  slots: RosterSlot[];
}) {
  const [state, action, pending] = useActionState(saveRosterSlots, empty);

  const [draft, setDraft] = useState<SlotDraft[]>(() =>
    slots.map((s) => ({
      slot_key: s.slot_key,
      label: s.label,
      eligible_positions: s.eligible_positions,
      count: s.count,
      is_starter: s.is_starter,
    })),
  );

  function patch(index: number, changes: Partial<SlotDraft>) {
    setDraft((prev) =>
      prev.map((slot, i) => (i === index ? { ...slot, ...changes } : slot)),
    );
  }

  const starterCount = draft
    .filter((s) => s.is_starter)
    .reduce((sum, s) => sum + s.count, 0);
  const totalCount = draft.reduce((sum, s) => sum + s.count, 0);

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="league_id" value={leagueId} />
      <input type="hidden" name="slots" value={JSON.stringify(draft)} />

      <div className="card">
        <p className="muted text-sm">
          {starterCount} starters, {totalCount - starterCount} bench/IR,{" "}
          {totalCount} roster spots in total. A slot with no positions ticked
          accepts anyone, which is how you build a FLEX or a bench.
        </p>
      </div>

      <ul className="space-y-3">
        {draft.map((slot, index) => (
          <li key={index} className="card space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Key</label>
                <input
                  className="input font-mono"
                  value={slot.slot_key}
                  onChange={(e) =>
                    patch(index, { slot_key: e.target.value.toUpperCase() })
                  }
                />
              </div>
              <div>
                <label className="label">Label</label>
                <input
                  className="input"
                  value={slot.label}
                  onChange={(e) => patch(index, { label: e.target.value })}
                />
              </div>
              <div>
                <label className="label">How many</label>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={20}
                  value={slot.count}
                  onChange={(e) =>
                    patch(index, { count: Number(e.target.value) })
                  }
                />
              </div>
              <div className="flex items-end">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={slot.is_starter}
                    onChange={(e) =>
                      patch(index, { is_starter: e.target.checked })
                    }
                  />
                  Counts toward the score
                </label>
              </div>
            </div>

            <div>
              <span className="label">Eligible positions</span>
              <div className="flex flex-wrap gap-2">
                {POSITIONS.map((position) => {
                  const on = slot.eligible_positions.includes(position);
                  return (
                    <button
                      key={position}
                      type="button"
                      className={`btn btn-sm ${on ? "btn-primary" : ""}`}
                      onClick={() =>
                        patch(index, {
                          eligible_positions: on
                            ? slot.eligible_positions.filter(
                                (p) => p !== position,
                              )
                            : [...slot.eligible_positions, position],
                        })
                      }
                    >
                      {position}
                    </button>
                  );
                })}
              </div>
              {slot.eligible_positions.length === 0 && (
                <p className="muted mt-1 text-xs">Any position.</p>
              )}
            </div>

            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() =>
                setDraft((prev) => prev.filter((_, i) => i !== index))
              }
            >
              Remove slot
            </button>
          </li>
        ))}
      </ul>

      <button
        type="button"
        className="btn w-full"
        onClick={() =>
          setDraft((prev) => [
            ...prev,
            {
              slot_key: `SLOT${prev.length + 1}`,
              label: "New slot",
              eligible_positions: [],
              count: 1,
              is_starter: true,
            },
          ])
        }
      >
        Add a slot
      </button>

      {state.error && <p className="error-box">{state.error}</p>}
      {state.ok && <p className="ok-box">{state.ok}</p>}

      <button className="btn btn-primary w-full" disabled={pending}>
        {pending ? "Saving..." : "Save roster settings"}
      </button>
      <p className="muted text-xs">
        Removing a slot benches anyone currently in it, for weeks that have
        not locked.
      </p>
    </form>
  );
}
