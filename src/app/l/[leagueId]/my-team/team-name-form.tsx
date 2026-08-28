"use client";

import { useActionState } from "react";
import { renameTeam, type LineupResult } from "./actions";

const empty: LineupResult = {};

export function TeamNameForm({
  leagueId,
  teamId,
  currentName,
}: {
  leagueId: string;
  teamId: string;
  currentName: string;
}) {
  const [state, action, pending] = useActionState(renameTeam, empty);

  return (
    <details className="card">
      <summary className="cursor-pointer text-sm font-medium">
        Team settings
      </summary>

      <form action={action} className="mt-4 space-y-3">
        <input type="hidden" name="league_id" value={leagueId} />
        <input type="hidden" name="team_id" value={teamId} />

        <div>
          <label className="label" htmlFor="team-name">
            Team name
          </label>
          <input
            id="team-name"
            name="name"
            className="input"
            defaultValue={currentName}
            required
          />
        </div>

        {state.error && <p className="error-box">{state.error}</p>}
        {state.ok && <p className="ok-box">{state.ok}</p>}

        <button className="btn" disabled={pending}>
          {pending ? "Saving..." : "Save"}
        </button>
      </form>
    </details>
  );
}
