"use client";

import {
  Fragment,
  useActionState,
  useMemo,
  useState,
  useTransition,
} from "react";
import type { RosterEntry } from "@/lib/roster";
import type { RosterSlot } from "@/lib/types";
import { expandSlots, positionLabel, slotAccepts } from "@/lib/roster-slots";
import { autoFill, type LineupSpot } from "@/lib/lineup";
import { useWideScreen } from "@/lib/use-wide-screen";
import {
  DroppedBadge,
  DroppedNote,
  GameStatusText,
  LockBadge,
  LockIcon,
  gameStatus,
  lockReason,
  lockRuleText,
  type LockMode,
} from "../lineup-lock";
import { saveLineup, dropPlayerById, type LineupResult } from "./actions";

const empty: LineupResult = {};

/**
 * The lineup, as a board of slots rather than a list of players.
 *
 * Every slot the league defines is drawn whether or not anyone is in it,
 * so an empty QB spot on Sunday morning is obvious. Moving a player is a
 * swap: pick a slot, choose who should be in it, and whoever was there
 * takes the incomer's place. That is the same gesture whether you are
 * filling an empty slot, benching a starter or swapping two starters,
 * which is why there is no separate "bench" or "start" action.
 *
 * Nobody sits outside the board. A player with no saved slot is dealt
 * into one on arrival -- the best available into each empty starting
 * spot, everyone else onto the bench -- so "on the roster but nowhere"
 * is not a state anybody discovers on a Sunday morning. The only players
 * left over are the ones a full roster genuinely has no room for, and
 * they are named as exactly that.
 *
 * Two views over the one board (Q9): a table on desktop, with the game
 * and the points in their own columns and Swap and Drop side by side;
 * a list on phones, one 44px action per row and Drop tucked into the
 * swap panel. A locked player keeps a full-strength row in both -- his
 * controls give way to a padlock chip, not a greyed-out button.
 */
export function LineupEditor({
  leagueId,
  teamId,
  season,
  week,
  slots,
  roster,
  lockMode,
  timeZone,
}: {
  leagueId: string;
  teamId: string;
  season: number;
  week: number;
  slots: RosterSlot[];
  roster: RosterEntry[];
  lockMode: LockMode;
  /** The league's timezone, for kickoff times. */
  timeZone: string;
}) {
  const [state, action, pending] = useActionState(saveLineup, empty);
  const wide = useWideScreen();

  const byPlayer = useMemo(
    () => new Map(roster.map((r) => [r.playerId, r])),
    [roster],
  );

  /** Every individual spot in the league's roster, in order. */
  const spots = useMemo(() => expandSlots(slots), [slots]);

  /**
   * spot key -> player id. Seeded from the saved lineup: players are
   * dealt into the spots matching the slot they were saved into.
   */
  const [placed, setPlaced] = useState<Record<string, string | null>>(() => {
    const next: Record<string, string | null> = {};
    const remaining = new Map<string, string[]>();

    for (const entry of roster) {
      if (!entry.slotKey) continue;
      const list = remaining.get(entry.slotKey) ?? [];
      list.push(entry.playerId);
      remaining.set(entry.slotKey, list);
    }

    for (const spot of spots) {
      next[spot.key] = remaining.get(spot.slotKey)?.shift() ?? null;
    }

    // Anybody the saved lineup did not account for gets a seat now,
    // rather than sitting in a limbo the scoring engine ignores.
    return autoFill(next, spots, roster);
  });

  /*
   * Whether that dealing actually moved anybody.
   *
   * Only worth saying so when it did: a lineup that came back exactly as
   * it was saved does not need a banner announcing that nothing
   * happened. Held in state so it describes the seed rather than
   * flickering off as soon as you touch a slot.
   */
  const [autoFilled] = useState(
    () => roster.filter((entry) => !entry.slotKey).length > 0,
  );

  const [openSpot, setOpenSpot] = useState<string | null>(null);

  const placedIds = new Set(
    Object.values(placed).filter((id): id is string => id !== null),
  );
  const unassigned = roster.filter((r) => !placedIds.has(r.playerId));

  /** Where a player is sitting right now, if anywhere. */
  function spotOf(playerId: string): string | null {
    return (
      Object.entries(placed).find(([, id]) => id === playerId)?.[0] ?? null
    );
  }

  /**
   * Puts `playerId` in `spotKey`, moving whoever was there to wherever
   * the incoming player came from. If he came from the unassigned pool,
   * the outgoing player joins it.
   */
  function put(spotKey: string, playerId: string | null) {
    setPlaced((prev) => {
      const next = { ...prev };
      const displaced = next[spotKey] ?? null;

      if (playerId === null) {
        next[spotKey] = null;
        return next;
      }

      const from = Object.entries(prev).find(([, id]) => id === playerId)?.[0];
      next[spotKey] = playerId;
      if (from && from !== spotKey) next[from] = displaced;

      return next;
    });
    setOpenSpot(null);
  }

  /** Seats everyone the board can still take. */
  function fillGaps() {
    setPlaced((prev) => autoFill(prev, spots, roster));
    setOpenSpot(null);
  }

  const starterSpots = spots.filter((s) => s.isStarter);

  const projectedTotal = starterSpots.reduce((sum, spot) => {
    const id = placed[spot.key];
    return sum + (id ? (byPlayer.get(id)?.points ?? 0) : 0);
  }, 0);

  const emptyStarters = starterSpots.filter((s) => !placed[s.key]).length;

  // "Fill the gaps" only when it would fill something: once the only
  // players who could take an empty starting spot are locked, the
  // button would do nothing, which reads as broken.
  const canFill =
    emptyStarters > 0 &&
    (() => {
      const filled = autoFill(placed, spots, roster);
      return starterSpots.some((s) => !placed[s.key] && filled[s.key]);
    })();

  const lockedCount = roster.filter((entry) => entry.locked).length;
  const allLocked = roster.length > 0 && lockedCount === roster.length;

  // Players the board still has to draw although they are off the
  // roster: dropped after kickoff, locked into this week's lineup.
  const droppedCount = roster.filter((entry) => !entry.onRoster).length;

  const listProps = {
    placed,
    byPlayer,
    openSpot,
    setOpenSpot,
    roster,
    spotOf,
    put,
    leagueId,
    teamId,
    lockMode,
    timeZone,
    wide,
  };

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="league_id" value={leagueId} />
      <input type="hidden" name="team_id" value={teamId} />
      <input type="hidden" name="season" value={season} />
      <input type="hidden" name="week" value={week} />

      {/* One field per player, carrying the slot he ended up in. The
          server contract is unchanged: an empty value means "not in the
          lineup this week". */}
      {roster.map((entry) => (
        <input
          key={entry.playerId}
          type="hidden"
          name={`slot__${entry.playerId}`}
          value={
            spots.find((s) => placed[s.key] === entry.playerId)?.slotKey ?? ""
          }
        />
      ))}

      <div className="card flex flex-wrap items-center gap-2 md:gap-3">
        <span className="pill">
          Starters {starterSpots.length - emptyStarters}/{starterSpots.length}
        </span>
        {emptyStarters > 0 && (
          <span className="pill border-negative text-negative">
            {emptyStarters} empty
          </span>
        )}
        {lockedCount > 0 && (
          <span className="badge-locked">
            <LockIcon />
            {allLocked ? "Lineup locked" : `${lockedCount} locked`}
          </span>
        )}
        <span className="pill ml-auto">{projectedTotal.toFixed(1)} pts</span>
        {canFill && (
          <button
            type="button"
            className={`btn ${wide ? "btn-sm" : "w-full"}`}
            onClick={fillGaps}
          >
            Fill the gaps
          </button>
        )}
      </div>

      <LockRule
        mode={lockMode}
        lockedCount={lockedCount}
        allLocked={allLocked}
        week={week}
        wide={wide}
      />

      {/* Once, under the lock rule it follows from -- not on every row. */}
      <DroppedNote count={droppedCount} mine />

      {autoFilled && (
        <p className="ok-box">
          Players who had no slot have been placed for you &mdash; starters
          first, the rest on the bench. Nothing is kept until you save.
        </p>
      )}

      <SpotList title="Starters" spots={starterSpots} {...listProps} />

      <SpotList
        title="Bench and reserve"
        spots={spots.filter((s) => !s.isStarter)}
        {...listProps}
      />

      {unassigned.length > 0 && (
        <section>
          <h2 className="h2 mb-2">No room on the roster</h2>
          <p className="muted mb-2 text-sm">
            More players than the roster has places for, so there is nowhere
            left to seat these. They score nothing. Drop one, or ask the
            commissioner for a bigger bench.
          </p>
          <ul className="card-tight divide-y divide-border/60">
            {unassigned.map((entry) => (
              <li key={entry.playerId} className="flex items-center gap-3 p-3">
                <PlayerLine entry={entry} timeZone={timeZone} />
                {entry.locked ? (
                  <LockBadge mode={lockMode} />
                ) : (
                  <DropButton
                    leagueId={leagueId}
                    teamId={teamId}
                    playerId={entry.playerId}
                    playerName={entry.player.full_name}
                    className={wide ? "btn-sm" : ""}
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {state.error && <p className="error-box">{state.error}</p>}
      {state.ok && <p className="ok-box">{state.ok}</p>}

      {/* Nothing left to save once everyone is locked, and a faded
          Save button reads as broken; the lock note already says why. */}
      {!allLocked && (
        <button className="btn btn-primary w-full md:w-auto" disabled={pending}>
          {pending ? "Saving..." : `Save week ${week} lineup`}
        </button>
      )}
    </form>
  );
}

/**
 * The league's lock rule, next to the lineup it applies to.
 *
 * Desktop always shows it: that is where a lineup is planned, and the
 * rule is part of the plan. A phone only needs it once it bites, so it
 * appears there when somebody is locked, cut to one line.
 */
function LockRule({
  mode,
  lockedCount,
  allLocked,
  week,
  wide,
}: {
  mode: LockMode;
  lockedCount: number;
  allLocked: boolean;
  week: number;
  wide: boolean;
}) {
  if (!wide && lockedCount === 0) return null;

  const now =
    lockedCount === 0
      ? null
      : allLocked
        ? `Week ${week} is locked.`
        : `${lockedCount} ${lockedCount === 1 ? "player is" : "players are"} locked now.`;

  if (!wide) {
    return (
      <p className="note-neutral">
        <LockIcon className="mt-0.5 size-3.5" />
        <span>
          {mode === "weekly_kickoff"
            ? `Lineup locked: week ${week}'s first game has kicked off.`
            : `${lockedCount} locked: ${lockedCount === 1 ? "his game has" : "their games have"} kicked off. Everyone else can still move.`}
        </span>
      </p>
    );
  }

  return (
    <p className="note-neutral">
      <LockIcon className="mt-0.5 size-3.5" />
      <span>
        <span className="font-semibold text-foreground">
          {mode === "weekly_kickoff"
            ? "Lineup lock: first kickoff of the week."
            : "Lineup lock: each player's kickoff."}
        </span>{" "}
        {lockRuleText(mode)}
        {now && <span className="text-foreground"> {now}</span>}
      </span>
    </p>
  );
}

interface ListProps {
  placed: Record<string, string | null>;
  byPlayer: Map<string, RosterEntry>;
  openSpot: string | null;
  setOpenSpot: (key: string | null) => void;
  roster: RosterEntry[];
  spotOf: (playerId: string) => string | null;
  put: (spotKey: string, playerId: string | null) => void;
  leagueId: string;
  teamId: string;
  lockMode: LockMode;
  timeZone: string;
  wide: boolean;
}

/** Everything one spot's row needs, worked out once for both views. */
function spotRow(spot: LineupSpot, props: ListProps) {
  const { placed, byPlayer, openSpot, roster } = props;
  const playerId = placed[spot.key];
  const entry = playerId ? byPlayer.get(playerId) : undefined;
  const locked = entry?.locked ?? false;
  const dropped = entry ? !entry.onRoster : false;
  const isOpen = openSpot === spot.key;

  const eligible = (r: RosterEntry) =>
    r.playerId !== playerId &&
    slotAccepts({ eligible_positions: spot.eligiblePositions }, r.player.position);

  // Anyone eligible for this spot who is not locked in place.
  const candidates = roster.filter((r) => !r.locked && eligible(r));
  const lockedOut = roster.filter((r) => r.locked && eligible(r)).length;

  return { entry, locked, dropped, isOpen, candidates, lockedOut };
}

function SpotList({
  title,
  spots,
  ...props
}: ListProps & { title: string; spots: LineupSpot[] }) {
  if (spots.length === 0) return null;

  return (
    <section>
      <h2 className="h2 mb-2">{title}</h2>
      {props.wide ? (
        <SpotTable spots={spots} {...props} />
      ) : (
        <SpotCards spots={spots} {...props} />
      )}
    </section>
  );
}

/** Desktop: a table, one column per thing worth comparing. */
function SpotTable({ spots, ...props }: ListProps & { spots: LineupSpot[] }) {
  const { setOpenSpot, lockMode, timeZone, leagueId, teamId } = props;

  return (
    <div className="card-tight">
      {/* Fixed widths so the starters and bench tables line up
          column for column. */}
      <table className="table table-fixed">
        <thead>
          <tr>
            <th className="w-20 pl-3">Slot</th>
            <th>Player</th>
            <th className="w-36">Game</th>
            <th className="w-20 text-right">Pts</th>
            <th className="w-44 pr-3">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {spots.map((spot) => {
            const { entry, locked, dropped, isOpen, candidates, lockedOut } =
              spotRow(spot, props);
            const status = entry
              ? gameStatus(entry.game, entry.player.team_abbr, timeZone)
              : null;

            return (
              <Fragment key={spot.key}>
                <tr className={locked ? "bg-surface-2/50" : undefined}>
                  <td className="pl-3 text-xs font-semibold tracking-wide text-muted uppercase">
                    {spot.label}
                  </td>
                  <td>
                    {entry ? (
                      <>
                        <span className="block truncate font-medium">
                          {entry.player.full_name}
                        </span>
                        <span className="muted block truncate text-xs">
                          {positionLabel(entry.player.position)} &middot;{" "}
                          {entry.player.team_abbr ?? "FA"}
                        </span>
                      </>
                    ) : (
                      <span className="muted italic">Empty</span>
                    )}
                  </td>
                  <td className="text-xs whitespace-nowrap">
                    {entry &&
                      (entry.game === null ? (
                        <span className="text-negative">BYE</span>
                      ) : (
                        <>
                          <span className="block">{entry.opponent}</span>
                          <span className="block text-muted tabular-nums">
                            <GameStatusText status={status} />
                          </span>
                        </>
                      ))}
                  </td>
                  <td className="text-right tabular-nums">
                    {entry && (
                      <>
                        {entry.points.toFixed(1)}
                        {!entry.isFinal && entry.points !== 0 && " *"}
                      </>
                    )}
                  </td>
                  <td className="pr-3">
                    <div className="flex flex-wrap items-center justify-end gap-1.5 whitespace-nowrap">
                      {dropped && <DroppedBadge />}
                      {locked ? (
                        <span title={`Locked: ${lockReason(lockMode)}`}>
                          <LockBadge mode={lockMode} />
                        </span>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="btn btn-sm"
                            aria-expanded={isOpen}
                            onClick={() => setOpenSpot(isOpen ? null : spot.key)}
                          >
                            {entry ? "Swap" : "Fill"}
                            <span className="sr-only"> {spot.label}</span>
                          </button>
                          {entry && (
                            <DropButton
                              leagueId={leagueId}
                              teamId={teamId}
                              playerId={entry.playerId}
                              playerName={entry.player.full_name}
                              className="btn-sm"
                            />
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={5} className="bg-surface-2/40 p-3">
                      <SwapPanel
                        spot={spot}
                        entry={entry}
                        candidates={candidates}
                        lockedOut={lockedOut}
                        {...props}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Phone: one row per spot, one thumb-sized action per row. A locked
 * player's row keeps its name and score at full strength; the padlock
 * takes the Swap button's place and the game status sits under his name.
 */
function SpotCards({ spots, ...props }: ListProps & { spots: LineupSpot[] }) {
  const { setOpenSpot, lockMode, timeZone } = props;

  return (
    <ul className="card-tight divide-y divide-border/60 overflow-hidden">
      {spots.map((spot) => {
        const { entry, locked, isOpen, candidates, lockedOut } = spotRow(
          spot,
          props,
        );

        return (
          <li
            key={spot.key}
            className={`px-3 py-2.5 ${locked ? "bg-surface-2/50" : ""}`}
          >
            <div className="flex min-h-11 items-center gap-3">
              <span className="w-11 shrink-0 text-xs font-semibold tracking-wide break-words text-muted uppercase">
                {spot.label}
              </span>

              {entry ? (
                <PlayerLine entry={entry} timeZone={timeZone} stacked />
              ) : (
                <span className="muted flex-1 text-sm italic">Empty</span>
              )}

              {locked ? (
                <LockBadge mode={lockMode} />
              ) : (
                <button
                  type="button"
                  className="btn min-w-18 shrink-0 px-3"
                  aria-expanded={isOpen}
                  onClick={() => setOpenSpot(isOpen ? null : spot.key)}
                >
                  {entry ? "Swap" : "Fill"}
                  <span className="sr-only"> {spot.label}</span>
                </button>
              )}
            </div>

            {isOpen && (
              <div className="mt-2.5 rounded-lg border border-border bg-surface-2/60 p-2">
                <SwapPanel
                  spot={spot}
                  entry={entry}
                  candidates={candidates}
                  lockedOut={lockedOut}
                  {...props}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Who can go into a spot, plus the spot's other moves. */
function SwapPanel({
  spot,
  entry,
  candidates,
  lockedOut,
  spotOf,
  put,
  leagueId,
  teamId,
  timeZone,
  wide,
}: ListProps & {
  spot: LineupSpot;
  entry: RosterEntry | undefined;
  candidates: RosterEntry[];
  /** Eligible players left out of the list because they are locked. */
  lockedOut: number;
}) {
  return (
    <div className="space-y-2">
      {entry && (
        <button
          type="button"
          className={`btn w-full ${wide ? "btn-sm" : ""}`}
          onClick={() => put(spot.key, null)}
        >
          Leave {spot.label} empty
        </button>
      )}

      {candidates.length === 0 ? (
        <p className="muted flex items-start gap-1.5 p-2 text-sm">
          {lockedOut > 0 ? (
            <>
              <LockIcon className="mt-0.5 size-3.5" />
              Everyone else who can play {spot.label} is locked.
            </>
          ) : (
            "Nobody else on your roster can play here."
          )}
        </p>
      ) : (
        <ul className="max-h-72 divide-y divide-border/60 overflow-y-auto rounded-md border border-border bg-surface">
          {candidates.map((candidate) => {
            const from = spotOf(candidate.playerId);
            return (
              <li key={candidate.playerId}>
                <button
                  type="button"
                  className="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                  onClick={() => put(spot.key, candidate.playerId)}
                >
                  <PlayerLine entry={candidate} timeZone={timeZone} />
                  <span className="muted shrink-0 text-xs">
                    {from ? "swap" : "add"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {candidates.length > 0 && lockedOut > 0 && (
        <p className="muted flex items-center gap-1.5 px-1 text-xs">
          <LockIcon />
          {lockedOut} locked {lockedOut === 1 ? "player isn't" : "players aren't"}{" "}
          listed.
        </p>
      )}

      {/* On a phone Drop lives here rather than in the row, so each row
          has one action and it can be a full-size target. */}
      {!wide && entry && (
        <DropButton
          leagueId={leagueId}
          teamId={teamId}
          playerId={entry.playerId}
          playerName={entry.player.full_name}
          className="w-full"
          quiet
          label={`Drop ${entry.player.full_name}`}
        />
      )}
    </div>
  );
}

/**
 * Name over a line of detail. `stacked` (the phone row) splits the
 * detail in two -- who he plays, then how it is going -- so neither is
 * truncated away on a narrow screen.
 */
function PlayerLine({
  entry,
  timeZone,
  stacked = false,
}: {
  entry: RosterEntry;
  timeZone: string;
  stacked?: boolean;
}) {
  const onBye = entry.game === null;
  const status = gameStatus(entry.game, entry.player.team_abbr, timeZone);

  const who = (
    <>
      {positionLabel(entry.player.position)} &middot;{" "}
      {entry.player.team_abbr ?? "FA"}
      {onBye ? (
        <span className="text-negative"> &middot; BYE</span>
      ) : (
        <> {entry.opponent}</>
      )}
    </>
  );

  const points = (
    <>
      {entry.points.toFixed(1)} pts
      {!entry.isFinal && entry.points !== 0 && " *"}
    </>
  );

  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm font-medium">
        {entry.player.full_name}
      </span>
      {stacked ? (
        <>
          <span className="muted block truncate text-xs">{who}</span>
          <span className="muted block truncate text-xs tabular-nums">
            {status && (
              <>
                <GameStatusText status={status} /> &middot;{" "}
              </>
            )}
            {points}
          </span>
        </>
      ) : (
        <span className="muted block truncate text-xs tabular-nums">
          {who}
          {status && (
            <>
              {" · "}
              <GameStatusText status={status} />
            </>
          )}
          {" · "}
          {points}
        </span>
      )}
    </span>
  );
}

/**
 * Calls the drop action directly rather than submitting a form: these
 * buttons sit inside the lineup form, and a form per row is not an
 * option (nested forms are invalid HTML) while a shared set of hidden
 * inputs would collide on field names.
 *
 * Never drawn for a locked player: a disabled red button reads as an
 * error, and the padlock already says why nothing can be done.
 */
function DropButton({
  leagueId,
  teamId,
  playerId,
  playerName,
  className = "",
  label = "Drop",
  quiet = false,
}: {
  leagueId: string;
  teamId: string;
  playerId: string;
  playerName: string;
  className?: string;
  label?: string;
  /** Outlined rather than filled, for a Drop that is not the main action. */
  quiet?: boolean;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      className={`btn shrink-0 ${
        quiet ? "border-negative/50 text-negative" : "btn-danger"
      } ${className}`}
      disabled={pending}
      aria-label={label === "Drop" ? `Drop ${playerName}` : undefined}
      onClick={() => {
        if (!confirm(`Drop ${playerName}? He goes on waivers.`)) return;
        startTransition(async () => {
          const result = await dropPlayerById(leagueId, teamId, playerId);
          if (result.error) alert(result.error);
        });
      }}
    >
      {label}
    </button>
  );
}
