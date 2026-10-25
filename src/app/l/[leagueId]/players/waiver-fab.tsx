"use client";

import { useEffect, useId, useRef, useState } from "react";
import { positionLabel } from "@/lib/roster-slots";
import { AvailabilityChip, Headshot } from "./player-bits";
import { PlayerActions, type DropOption } from "./player-actions";

/** The addable players handed to the sheet: only the fields it shows. */
export interface AddablePlayer {
  player_id: string;
  full_name: string;
  pos: string | null;
  team_abbr: string | null;
  on_waivers: boolean;
  headshot_url: string | null;
}

/**
 * The phone's add control: a floating button that opens a bottom sheet of
 * the free agents and waiver players on the current page, each with the
 * add / bid flow inline.
 *
 * The cards in the list are read-only and link to the player page; adding
 * is a deliberate action, so it lives behind one tap on the FAB rather
 * than putting a button on every card. The sheet is a native <dialog>
 * (showModal) for the free focus trap, inert background and Escape-to-
 * close, and floats clear of the fixed bottom nav via bottom-above-nav.
 */
export function WaiverFab({
  leagueId,
  teamId,
  waiverType,
  faabRemaining,
  dropOptions,
  players,
}: {
  leagueId: string;
  teamId: string;
  waiverType: "faab" | "priority";
  faabRemaining: number;
  dropOptions: DropOption[];
  players: AddablePlayer[];
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  // Lock the page behind the sheet: showModal makes it inert, not
  // unscrollable, and a page sliding under a sheet feels broken.
  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = previous;
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="bottom-above-nav fixed right-4 z-40 inline-flex h-14 items-center gap-1.5 rounded-full bg-accent pr-5 pl-4 font-semibold text-accent-ink shadow-elev-2 transition-colors hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent md:hidden"
      >
        <span aria-hidden className="text-2xl leading-none">
          +
        </span>
        Add player
      </button>

      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        onClose={close}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
        className="sheet md:hidden"
      >
        <div className="sheet-body">
          <div className="flex items-start justify-between gap-3 pb-3">
            <div className="min-w-0">
              <h2 id={titleId} className="h2">
                Add a player
              </h2>
              <p className="muted text-xs">
                Free agents and waiver players on this page.
              </p>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="-mr-2 -mt-1 inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent"
            >
              <span aria-hidden className="text-xl leading-none">
                &times;
              </span>
            </button>
          </div>

          {players.length === 0 ? (
            <p className="muted py-8 text-center text-sm">
              No available players on this page. Adjust the filters or search
              to find free agents to add.
            </p>
          ) : (
            <ul className="space-y-2">
              {players.map((player) => (
                <li
                  key={player.player_id}
                  className="rounded-lg border border-border bg-surface-2 p-3"
                >
                  <div className="flex items-center gap-3">
                    <Headshot
                      url={player.headshot_url}
                      name={player.full_name}
                      size={36}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">
                        {player.full_name}
                      </p>
                      <p className="muted truncate text-xs">
                        {positionLabel(player.pos)}
                        {player.team_abbr ? ` · ${player.team_abbr}` : ""}
                      </p>
                    </div>
                    <AvailabilityChip
                      team={null}
                      ownerName={null}
                      onWaivers={player.on_waivers}
                    />
                  </div>
                  <div className="mt-3">
                    <PlayerActions
                      layout="inline"
                      leagueId={leagueId}
                      teamId={teamId}
                      playerId={player.player_id}
                      playerName={player.full_name}
                      onWaivers={player.on_waivers}
                      waiverType={waiverType}
                      faabRemaining={faabRemaining}
                      dropOptions={dropOptions}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </dialog>
    </>
  );
}
