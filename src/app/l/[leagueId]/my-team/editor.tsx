"use client";

import { useActionState, useMemo, useState, useTransition } from "react";
import type { RosterEntry } from "@/lib/roster";
import type { RosterSlot } from "@/lib/types";
import { slotAccepts } from "@/lib/roster-slots";
import { saveLineup, dropPlayerById, type LineupResult } from "./actions";

const empty: LineupResult = {};

/** The value used in the select for "not in the lineup this week". */
const UNASSIGNED = "";

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

  // Held locally so the slot counts update as you edit, before saving.
  const [assignments, setAssignments] = useState<Record<string, string>>(() =>
    Object.fromEntries(roster.map((r) => [r.playerId, r.slotKey ?? UNASSIGNED])),
  );

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const slotKey of Object.values(assignments)) {
      if (slotKey) map.set(slotKey, (map.get(slotKey) ?? 0) + 1);
    }
    return map;
  }, [assignments]);

  const starterSlots = slots.filter((s) => s.is_starter);

  const projectedTotal = roster
    .filter((r) => {
      const slotKey = assignments[r.playerId];
      return slotKey && starterSlots.some((s) => s.slot_key === slotKey);
    })
    .reduce((sum, r) => sum + r.points, 0);

  const overfilled = slots.filter(
    (s) => (counts.get(s.slot_key) ?? 0) > s.count,
  );

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="league_id" value={leagueId} />
      <input type="hidden" name="team_id" value={teamId} />
      <input type="hidden" name="season" value={season} />
      <input type="hidden" name="week" value={week} />

      {/* Slot usage, so it is obvious what still needs filling. */}
      <div className="card flex flex-wrap gap-2">
        {slots.map((slot) => {
          const used = counts.get(slot.slot_key) ?? 0;
          const full = used === slot.count;
          const over = used > slot.count;
          return (
            <span
              key={slot.slot_key}
              className={`pill ${
                over
                  ? "border-negative text-negative"
                  : full
                    ? "border-positive text-positive"
                    : ""
              }`}
            >
              {slot.label} {used}/{slot.count}
            </span>
          );
        })}
        <span className="pill ml-auto">
          Starters: {projectedTotal.toFixed(1)} pts
        </span>
      </div>

      <div className="card-tight table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Player</th>
              <th className="w-32">Slot</th>
              <th className="text-right">Pts</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {roster.map((entry) => (
              <PlayerRow
                key={entry.playerId}
                entry={entry}
                slots={slots}
                value={assignments[entry.playerId] ?? UNASSIGNED}
                onChange={(slotKey) =>
                  setAssignments((prev) => ({
                    ...prev,
                    [entry.playerId]: slotKey,
                  }))
                }
                leagueId={leagueId}
                teamId={teamId}
              />
            ))}
          </tbody>
        </table>
      </div>

      {overfilled.length > 0 && (
        <p className="error-box">
          Too many players at {overfilled.map((s) => s.label).join(", ")}.
        </p>
      )}
      {state.error && <p className="error-box">{state.error}</p>}
      {state.ok && <p className="ok-box">{state.ok}</p>}

      <button
        className="btn btn-primary w-full md:w-auto"
        disabled={pending || overfilled.length > 0}
      >
        {pending ? "Saving..." : `Save week ${week} lineup`}
      </button>
    </form>
  );
}

function PlayerRow({
  entry,
  slots,
  value,
  onChange,
  leagueId,
  teamId,
}: {
  entry: RosterEntry;
  slots: RosterSlot[];
  value: string;
  onChange: (slotKey: string) => void;
  leagueId: string;
  teamId: string;
}) {
  const eligible = slots.filter((s) => slotAccepts(s, entry.player.position));
  const onBye = entry.game === null;

  return (
    <tr>
      <td>
        <span className="block font-medium">{entry.player.full_name}</span>
        <span className="muted text-xs">
          {entry.player.position ?? "?"} &middot;{" "}
          {entry.player.team_abbr ?? "FA"}
          {onBye ? (
            <span className="text-negative"> &middot; BYE</span>
          ) : (
            <> &middot; {entry.opponent}</>
          )}
          {entry.locked && <> &middot; locked</>}
        </span>
      </td>

      <td>
        <select
          className="input"
          name={`slot__${entry.playerId}`}
          value={value}
          disabled={entry.locked}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`Slot for ${entry.player.full_name}`}
        >
          <option value={UNASSIGNED}>&mdash;</option>
          {eligible.map((slot) => (
            <option key={slot.slot_key} value={slot.slot_key}>
              {slot.label}
            </option>
          ))}
        </select>
      </td>

      <td className="text-right tabular-nums">
        {entry.points.toFixed(1)}
        {!entry.isFinal && entry.points !== 0 && (
          <span className="muted text-xs"> *</span>
        )}
      </td>

      <td>
        <DropButton
          leagueId={leagueId}
          teamId={teamId}
          playerId={entry.playerId}
          playerName={entry.player.full_name}
          disabled={entry.locked}
        />
      </td>
    </tr>
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
  const [error, setError] = useState<string | null>(null);

  return (
    <button
      type="button"
      className="btn btn-sm btn-danger"
      disabled={disabled || pending}
      title={error ?? `Drop ${playerName}`}
      onClick={() => {
        if (!confirm(`Drop ${playerName}? He goes on waivers.`)) return;
        startTransition(async () => {
          const result = await dropPlayerById(leagueId, teamId, playerId);
          setError(result.error ?? null);
          if (result.error) alert(result.error);
        });
      }}
    >
      Drop
    </button>
  );
}
