"use client";

import { useActionState } from "react";
import type { League } from "@/lib/types";
import { saveLeagueSettings, type AdminResult } from "./actions";

const empty: AdminResult = {};

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function SettingsPanel({ league }: { league: League }) {
  const [state, action, pending] = useActionState(saveLeagueSettings, empty);

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="league_id" value={league.id} />

      <section className="card space-y-3">
        <h3 className="h2">League</h3>

        <Field label="Name" htmlFor="name">
          <input
            id="name"
            name="name"
            className="input"
            defaultValue={league.name}
            required
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Current week" htmlFor="current_week">
            <input
              id="current_week"
              name="current_week"
              type="number"
              min={1}
              max={22}
              className="input"
              defaultValue={league.current_week}
            />
          </Field>

          <Field label="Season status" htmlFor="status">
            <select
              id="status"
              name="status"
              className="input"
              defaultValue={league.status}
            >
              <option value="setup">Setup</option>
              <option value="drafting">Drafting</option>
              <option value="in_season">In season</option>
              <option value="playoffs">Playoffs</option>
              <option value="complete">Complete</option>
            </select>
          </Field>

          <Field label="Regular season weeks" htmlFor="regular_season_weeks">
            <input
              id="regular_season_weeks"
              name="regular_season_weeks"
              type="number"
              min={1}
              max={18}
              className="input"
              defaultValue={league.regular_season_weeks}
            />
          </Field>

          <Field label="Playoffs start week" htmlFor="playoff_start_week">
            <input
              id="playoff_start_week"
              name="playoff_start_week"
              type="number"
              min={1}
              max={22}
              className="input"
              defaultValue={league.playoff_start_week}
            />
          </Field>

          <Field label="Playoff teams" htmlFor="playoff_teams">
            <input
              id="playoff_teams"
              name="playoff_teams"
              type="number"
              min={2}
              max={16}
              className="input"
              defaultValue={league.playoff_teams}
            />
          </Field>

          <Field label="Timezone" htmlFor="timezone">
            <input
              id="timezone"
              name="timezone"
              className="input"
              defaultValue={league.timezone}
            />
          </Field>
        </div>
      </section>

      <section className="card space-y-3">
        <h3 className="h2">Waivers</h3>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Type" htmlFor="waiver_type">
            <select
              id="waiver_type"
              name="waiver_type"
              className="input"
              defaultValue={league.waiver_type}
            >
              <option value="faab">FAAB blind bidding</option>
              <option value="priority">Rolling priority</option>
            </select>
          </Field>

          <Field label="FAAB budget" htmlFor="faab_budget">
            <input
              id="faab_budget"
              name="faab_budget"
              type="number"
              min={0}
              className="input"
              defaultValue={league.faab_budget}
            />
          </Field>

          <Field label="Minimum bid" htmlFor="min_bid">
            <input
              id="min_bid"
              name="min_bid"
              type="number"
              min={0}
              className="input"
              defaultValue={league.min_bid}
            />
          </Field>

          <Field label="Tie breaker" htmlFor="faab_tie_breaker">
            <select
              id="faab_tie_breaker"
              name="faab_tie_breaker"
              className="input"
              defaultValue={league.faab_tie_breaker}
            >
              <option value="waiver_priority">Waiver priority</option>
              <option value="earliest_bid">Earliest bid</option>
              <option value="random">Random</option>
            </select>
          </Field>

          <Field label="Process day" htmlFor="waiver_process_dow">
            <select
              id="waiver_process_dow"
              name="waiver_process_dow"
              className="input"
              defaultValue={league.waiver_process_dow}
            >
              {DAYS.map((day, i) => (
                <option key={day} value={i}>
                  {day}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Process time" htmlFor="waiver_process_time">
            <input
              id="waiver_process_time"
              name="waiver_process_time"
              type="time"
              className="input"
              defaultValue={league.waiver_process_time.slice(0, 5)}
            />
          </Field>

          <Field
            label="Waiver period (hours)"
            htmlFor="waiver_period_hours"
            hint="How long a dropped player sits before becoming a free agent. 0 = instantly."
          >
            <input
              id="waiver_period_hours"
              name="waiver_period_hours"
              type="number"
              min={0}
              className="input"
              defaultValue={league.waiver_period_hours}
            />
          </Field>

          <Field label="Lineup lock" htmlFor="lineup_lock_mode">
            <select
              id="lineup_lock_mode"
              name="lineup_lock_mode"
              className="input"
              defaultValue={league.lineup_lock_mode}
            >
              <option value="per_player">At each player&apos;s kickoff</option>
              <option value="weekly_kickoff">At the first game of the week</option>
            </select>
          </Field>
        </div>
      </section>

      {state.error && <p className="error-box">{state.error}</p>}
      {state.ok && <p className="ok-box">{state.ok}</p>}

      <button className="btn btn-primary w-full md:w-auto" disabled={pending}>
        {pending ? "Saving..." : "Save settings"}
      </button>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <p className="muted mt-1 text-xs">{hint}</p>}
    </div>
  );
}
