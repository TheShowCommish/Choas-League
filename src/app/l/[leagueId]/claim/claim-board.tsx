"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { claimTeam } from "../my-team/actions";

export interface BoardTeam {
  id: string;
  name: string;
  color: string;
  logoUrl: string | null;
  slotNumber: number | null;
  /** null when the team is still free. */
  ownerName: string | null;
}

export function ClaimBoard({
  leagueId,
  teams,
}: {
  leagueId: string;
  teams: BoardTeam[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function claim() {
    if (!selected) return;
    setError(null);
    startTransition(async () => {
      const result = await claimTeam(leagueId, selected, name);
      if (result.error) {
        setError(result.error);
        return;
      }
      router.replace(`/l/${leagueId}/my-team`);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {teams.map((team) => {
          const taken = team.ownerName !== null;
          const active = selected === team.id;

          return (
            <li key={team.id}>
              <button
                type="button"
                disabled={taken || pending}
                onClick={() => setSelected(team.id)}
                className={`card flex w-full items-center gap-3 text-left transition ${
                  taken
                    ? "cursor-not-allowed opacity-50"
                    : active
                      ? "border-accent"
                      : "hover:border-accent"
                }`}
              >
                {team.logoUrl ? (
                  // Manager-supplied URL from any host; see team settings.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={team.logoUrl}
                    alt=""
                    className="size-10 shrink-0 rounded-lg object-cover"
                  />
                ) : (
                  <span
                    className="size-10 shrink-0 rounded-lg"
                    style={{ backgroundColor: team.color }}
                    aria-hidden
                  />
                )}

                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {team.name}
                  </span>
                  <span className="muted block truncate text-xs">
                    {taken ? team.ownerName : "Free"}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {selected && (
        <div className="card space-y-3">
          <div>
            <label className="label" htmlFor="claim-name">
              Name your team (optional)
            </label>
            <input
              id="claim-name"
              className="input"
              placeholder="Leave blank to keep the current name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {error && <p className="error-box">{error}</p>}

          <button
            className="btn btn-primary w-full"
            disabled={pending}
            onClick={claim}
          >
            {pending ? "Claiming..." : "Claim this team"}
          </button>
        </div>
      )}
    </div>
  );
}
