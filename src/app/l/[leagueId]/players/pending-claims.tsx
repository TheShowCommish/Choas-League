"use client";

import { useTransition } from "react";
import type { WaiverClaim } from "@/lib/types";
import { cancelWaiverClaim } from "./actions";

/**
 * Your own pending waiver claims. Only you can see these -- the RLS
 * policy on waiver_claims hides a pending row from everyone but the
 * bidding team, which is what makes blind bidding blind.
 */
export function PendingClaims({
  leagueId,
  claims,
  playerNames,
  waiverType,
}: {
  leagueId: string;
  claims: WaiverClaim[];
  playerNames: Record<string, string>;
  waiverType: "faab" | "priority";
}) {
  const [pending, startTransition] = useTransition();

  return (
    <section className="card">
      <h2 className="h2 mb-1">Your pending claims</h2>
      <p className="muted mb-3 text-xs">
        Visible only to you until waivers process.
      </p>

      <ul className="space-y-2">
        {claims.map((claim) => (
          <li
            key={claim.id}
            className="flex items-center justify-between gap-3 border-b border-border/60 pb-2 last:border-b-0 last:pb-0"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {playerNames[claim.add_player_id] ?? claim.add_player_id}
              </p>
              <p className="muted text-xs">
                {waiverType === "faab" && <>${claim.bid_amount} bid</>}
                {claim.drop_player_id && (
                  <>
                    {waiverType === "faab" && " · "}
                    drop{" "}
                    {playerNames[claim.drop_player_id] ?? claim.drop_player_id}
                  </>
                )}
              </p>
            </div>

            <button
              type="button"
              className="btn btn-sm"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  await cancelWaiverClaim(leagueId, claim.id);
                })
              }
            >
              Cancel
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
