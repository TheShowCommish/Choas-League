"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { RosterSlot, Team } from "@/lib/types";
import { tradeImpact, type TradeImpact } from "@/lib/trade-impact";
import type { TradePlayerOption } from "./page";
import { proposeTrade } from "./actions";
import { PlayerValue, TradeImpactBlock } from "./trade-impact-view";

export function ProposeTrade({
  leagueId,
  myTeam,
  otherTeams,
  rosters,
  rosterSlots,
  positionLimits,
}: {
  leagueId: string;
  myTeam: Team;
  otherTeams: Team[];
  rosters: Record<string, TradePlayerOption[]>;
  rosterSlots: RosterSlot[];
  positionLimits: Record<string, number>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [partnerId, setPartnerId] = useState(otherTeams[0]?.id ?? "");
  const [giving, setGiving] = useState<string[]>([]);
  const [receiving, setReceiving] = useState<string[]>([]);
  const [faab, setFaab] = useState("0");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const myRoster = useMemo(
    () => rosters[myTeam.id] ?? [],
    [rosters, myTeam.id],
  );
  const theirRoster = useMemo(
    () => rosters[partnerId] ?? [],
    [rosters, partnerId],
  );
  const partner = otherTeams.find((t) => t.id === partnerId) ?? null;

  // The live trade preview (T-073): recompute both teams' before/after best
  // starting lineup and legality as the two sides are picked. Season average
  // is the lineup metric; the per-player projection is shown next to a name.
  const impact: TradeImpact = useMemo(() => {
    const byId = new Map(
      [...myRoster, ...theirRoster].map((p) => [p.playerId, p]),
    );
    const lookup = (ids: string[]): TradePlayerOption[] =>
      ids.map((id) => byId.get(id)).filter((p): p is TradePlayerOption => !!p);

    return tradeImpact(
      { roster: myRoster, outgoing: giving, incoming: lookup(receiving) },
      { roster: theirRoster, outgoing: receiving, incoming: lookup(giving) },
      rosterSlots,
      positionLimits,
    );
  }, [myRoster, theirRoster, giving, receiving, rosterSlots, positionLimits]);

  const hasSelection = giving.length > 0 || receiving.length > 0;

  function toggle(
    list: string[],
    setList: (next: string[]) => void,
    playerId: string,
  ) {
    setList(
      list.includes(playerId)
        ? list.filter((id) => id !== playerId)
        : [...list, playerId],
    );
  }

  function submit() {
    setMessage(null);
    startTransition(async () => {
      const result = await proposeTrade(
        leagueId,
        myTeam.id,
        partnerId,
        giving,
        receiving,
        Number(faab) || 0,
        note,
      );

      if (result.error) {
        setMessage(result.error);
        return;
      }

      setGiving([]);
      setReceiving([]);
      setFaab("0");
      setNote("");
      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <button className="btn btn-primary" onClick={() => setOpen(true)}>
        Propose a trade
      </button>
    );
  }

  return (
    <section className="card space-y-4">
      <div>
        <label className="label" htmlFor="partner">
          Trade with
        </label>
        <select
          id="partner"
          className="input"
          value={partnerId}
          onChange={(e) => {
            setPartnerId(e.target.value);
            setReceiving([]);
          }}
        >
          {otherTeams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <PlayerPicker
          title="You give"
          players={myRoster}
          selected={giving}
          onToggle={(id) => toggle(giving, setGiving, id)}
        />
        <PlayerPicker
          title="You get"
          players={theirRoster}
          selected={receiving}
          onToggle={(id) => toggle(receiving, setReceiving, id)}
        />
      </div>

      {hasSelection && (
        <ImpactPreview
          myName={myTeam.name}
          theirName={partner?.name ?? "Them"}
          impact={impact}
        />
      )}

      <div>
        <label className="label" htmlFor="faab">
          FAAB you are throwing in (${myTeam.faab_remaining} available)
        </label>
        <input
          id="faab"
          type="number"
          min={0}
          max={myTeam.faab_remaining}
          className="input"
          value={faab}
          onChange={(e) => setFaab(e.target.value)}
        />
      </div>

      <div>
        <label className="label" htmlFor="note">
          Message (optional)
        </label>
        <input
          id="note"
          className="input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
        />
      </div>

      {message && <p className="error-box">{message}</p>}

      <div className="flex gap-2">
        <button
          className="btn btn-primary flex-1"
          onClick={submit}
          disabled={pending}
        >
          {pending ? "Sending..." : "Send offer"}
        </button>
        <button className="btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </section>
  );
}

function PlayerPicker({
  title,
  players,
  selected,
  onToggle,
}: {
  title: string;
  players: TradePlayerOption[];
  selected: string[];
  onToggle: (playerId: string) => void;
}) {
  return (
    <div>
      <p className="label">
        {title}
        {selected.length > 0 && ` (${selected.length})`}
      </p>

      {players.length === 0 ? (
        <p className="muted text-sm">No players on that roster.</p>
      ) : (
        <ul className="card-tight max-h-56 divide-y divide-border/60 overflow-y-auto">
          {players.map((player) => (
            <li key={player.playerId}>
              <label className="flex min-h-11 cursor-pointer items-center gap-2 px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 shrink-0 accent-accent"
                  checked={selected.includes(player.playerId)}
                  onChange={() => onToggle(player.playerId)}
                />
                <span className="min-w-0 truncate">{player.label}</span>
                {/* Decision support (T-073): season average primary, the
                    next-week projection muted beside it. */}
                <PlayerValue
                  avg={player.avg}
                  projection={player.projection}
                  className="ml-auto shrink-0 text-xs"
                />
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The live trade preview (T-073): each team's best starting lineup before and
 * after, and any roster-legality warning. The look lives in the shared
 * TradeImpactBlock so the propose screen and the inbox read identically.
 */
function ImpactPreview({
  myName,
  theirName,
  impact,
}: {
  myName: string;
  theirName: string;
  impact: TradeImpact;
}) {
  return (
    <TradeImpactBlock
      proposingName={myName}
      receivingName={theirName}
      impact={impact}
      className="card-tight p-3"
    />
  );
}
