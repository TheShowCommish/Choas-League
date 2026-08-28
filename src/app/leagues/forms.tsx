"use client";

import { useActionState, useState } from "react";
import { createLeague, joinLeague, type ActionResult } from "./actions";

const empty: ActionResult = {};

export function LeagueForms() {
  const [tab, setTab] = useState<"join" | "create">("join");

  return (
    <section>
      <div className="mb-3 flex gap-2">
        <button
          className={`btn btn-sm flex-1 ${tab === "join" ? "btn-primary" : ""}`}
          onClick={() => setTab("join")}
        >
          Join a league
        </button>
        <button
          className={`btn btn-sm flex-1 ${tab === "create" ? "btn-primary" : ""}`}
          onClick={() => setTab("create")}
        >
          Create a league
        </button>
      </div>

      {tab === "join" ? <JoinForm /> : <CreateForm />}
    </section>
  );
}

function JoinForm() {
  const [state, action, pending] = useActionState(joinLeague, empty);

  return (
    <form action={action} className="card space-y-4">
      <div>
        <label className="label" htmlFor="join_code">
          Join code
        </label>
        <input
          id="join_code"
          name="join_code"
          className="input uppercase"
          placeholder="A1B2C3D4"
          required
        />
      </div>
      <div>
        <label className="label" htmlFor="join_team_name">
          Your team name
        </label>
        <input
          id="join_team_name"
          name="team_name"
          className="input"
          placeholder="The Chaos Agents"
        />
      </div>
      {state.error && <p className="error-box">{state.error}</p>}
      <button className="btn btn-primary w-full" disabled={pending}>
        {pending ? "Joining..." : "Join league"}
      </button>
    </form>
  );
}

function CreateForm() {
  const [state, action, pending] = useActionState(createLeague, empty);
  const thisYear = new Date().getFullYear();

  return (
    <form action={action} className="card space-y-4">
      <div>
        <label className="label" htmlFor="name">
          League name
        </label>
        <input id="name" name="name" className="input" required />
      </div>
      <div>
        <label className="label" htmlFor="season">
          Season
        </label>
        <input
          id="season"
          name="season"
          type="number"
          className="input"
          defaultValue={thisYear}
          min={2000}
          max={2100}
        />
      </div>
      <div>
        <label className="label" htmlFor="create_team_name">
          Your team name
        </label>
        <input id="create_team_name" name="team_name" className="input" />
      </div>
      {state.error && <p className="error-box">{state.error}</p>}
      <button className="btn btn-primary w-full" disabled={pending}>
        {pending ? "Creating..." : "Create league"}
      </button>
      <p className="muted">
        You will be the commissioner. Settings, scoring and the draft are all
        yours to configure afterwards.
      </p>
    </form>
  );
}
