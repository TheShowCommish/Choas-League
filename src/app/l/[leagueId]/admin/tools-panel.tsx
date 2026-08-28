"use client";

import { useState, useTransition } from "react";
import type { Draft, League, Team } from "@/lib/types";
import type { MemberRow } from "./tabs";
import {
  assignTeamOwner,
  generateSchedule,
  processWaivers,
  recomputeScores,
  setDraftStatus,
  setupDraft,
  type AdminResult,
} from "./actions";

export function ToolsPanel({
  league,
  teams,
  members,
  draft,
}: {
  league: League;
  teams: Team[];
  members: MemberRow[];
  draft: Draft | null;
}) {
  const [result, setResult] = useState<AdminResult>({});
  const [pending, startTransition] = useTransition();

  /** Runs an action and surfaces whatever it says, success or failure. */
  function run(fn: () => Promise<AdminResult>, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return;
    startTransition(async () => setResult(await fn()));
  }

  return (
    <div className="space-y-4">
      {result.error && <p className="error-box">{result.error}</p>}
      {result.ok && <p className="ok-box">{result.ok}</p>}

      <section className="card space-y-3">
        <h3 className="h2">Season</h3>

        <Tool
          title="Generate the schedule"
          description={`Builds a round-robin over ${league.regular_season_weeks} weeks for the ${teams.length} teams in the league. Replaces any existing regular season matchups.`}
          button="Generate schedule"
          disabled={pending}
          onClick={() =>
            run(
              () => generateSchedule(league.id),
              "This replaces the existing regular season schedule. Continue?",
            )
          }
        />

        <Tool
          title="Process waivers now"
          description="Resolves every pending claim immediately, rather than waiting for the scheduled run."
          button="Process waivers"
          disabled={pending}
          onClick={() =>
            run(
              () => processWaivers(league.id),
              "Process all pending waiver claims now?",
            )
          }
        />

        <Tool
          title="Recompute scores"
          description="Re-scores every week of the season against the current scoring rules. Run this after changing scoring."
          button="Recompute all weeks"
          disabled={pending}
          onClick={() => run(() => recomputeScores(league.id, null))}
        />

        <Tool
          title="Recompute this week only"
          description={`Just week ${league.current_week}. Faster if you only need the live week refreshed.`}
          button={`Recompute week ${league.current_week}`}
          disabled={pending}
          onClick={() => run(() => recomputeScores(league.id, league.current_week))}
        />
      </section>

      <section className="card space-y-3">
        <h3 className="h2">Draft</h3>

        {draft && (
          <p className="muted text-sm">
            Current draft: {draft.type}, {draft.rounds} rounds,{" "}
            {draft.seconds_per_pick}s per pick &middot; status{" "}
            <strong>{draft.status}</strong>
            {draft.status !== "complete" && (
              <> &middot; on pick {draft.current_pick_number}</>
            )}
          </p>
        )}

        <form
          className="space-y-3"
          action={(formData) =>
            startTransition(async () =>
              setResult(await setupDraft(league.id, formData)),
            )
          }
        >
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="draft-type">
                Format
              </label>
              <select
                id="draft-type"
                name="type"
                className="input"
                defaultValue={draft?.type ?? league.draft_type}
              >
                <option value="snake">Snake</option>
                <option value="auction">Auction</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="rounds">
                Rounds
              </label>
              <input
                id="rounds"
                name="rounds"
                type="number"
                min={1}
                max={40}
                className="input"
                defaultValue={draft?.rounds ?? 16}
              />
            </div>
            <div>
              <label className="label" htmlFor="seconds_per_pick">
                Seconds per pick
              </label>
              <input
                id="seconds_per_pick"
                name="seconds_per_pick"
                type="number"
                min={10}
                max={600}
                className="input"
                defaultValue={draft?.seconds_per_pick ?? 90}
              />
            </div>
            <div>
              <label className="label" htmlFor="auction_budget">
                Auction budget
              </label>
              <input
                id="auction_budget"
                name="auction_budget"
                type="number"
                min={1}
                className="input"
                defaultValue={draft?.auction_budget ?? 200}
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="randomize"
              className="size-4"
              defaultChecked
            />
            Randomise the draft order
          </label>

          <button className="btn btn-primary w-full" disabled={pending}>
            Generate the draft board
          </button>
          <p className="muted text-xs">
            This wipes any picks already made. Do it before draft night, not
            during.
          </p>
        </form>

        {draft && (
          <div className="flex flex-wrap gap-2">
            <button
              className="btn btn-primary"
              disabled={pending || draft.status === "live"}
              onClick={() => run(() => setDraftStatus(league.id, "live"))}
            >
              Start / resume
            </button>
            <button
              className="btn"
              disabled={pending || draft.status !== "live"}
              onClick={() => run(() => setDraftStatus(league.id, "paused"))}
            >
              Pause
            </button>
            <button
              className="btn btn-danger"
              disabled={pending || draft.status === "complete"}
              onClick={() =>
                run(
                  () => setDraftStatus(league.id, "complete"),
                  "End the draft? The room disappears from the nav.",
                )
              }
            >
              End draft
            </button>
          </div>
        )}
      </section>

      <section className="card space-y-3">
        <h3 className="h2">Teams and managers</h3>
        <p className="muted text-sm">
          Share the join code to add managers. Anyone already in the league can
          be handed an unclaimed team here.
        </p>

        <ul className="divide-y divide-border/60">
          {teams.map((team) => (
            <li key={team.id} className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm">
                {team.name}
              </span>
              <select
                className="input w-44"
                defaultValue={team.owner_id ?? ""}
                disabled={pending}
                onChange={(e) =>
                  run(() =>
                    assignTeamOwner(
                      league.id,
                      team.id,
                      e.target.value || null,
                    ),
                  )
                }
                aria-label={`Owner of ${team.name}`}
              >
                <option value="">Unclaimed</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Tool({
  title,
  description,
  button,
  disabled,
  onClick,
}: {
  title: string;
  description: string;
  button: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-3 last:border-b-0 last:pb-0">
      <div className="min-w-56 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="muted text-xs">{description}</p>
      </div>
      <button className="btn btn-sm" disabled={disabled} onClick={onClick}>
        {button}
      </button>
    </div>
  );
}
