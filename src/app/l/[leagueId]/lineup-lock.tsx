import type { League, NflGame } from "@/lib/types";

/**
 * How a lineup lock looks, wherever a roster is drawn.
 *
 * Presentation only: whether a player is locked is decided by the
 * database (lineup_locks) and arrives as RosterEntry.locked. This file
 * turns that flag, the league's lock mode and the player's NFL game into
 * words and a padlock, so My Team and the team page say the same thing.
 * Also the lock's one side effect worth marking: a player dropped after
 * kickoff, who stays in the week's lineup without being on the roster.
 * No "use client": the team page renders it on the server, the lineup
 * editor on the client.
 */

export type LockMode = League["lineup_lock_mode"];

/** Why a locked player is locked, read out after the word "Locked". */
export function lockReason(mode: LockMode): string {
  return mode === "weekly_kickoff"
    ? "the lineup locked at the week's first kickoff"
    : "his game has kicked off";
}

export function LockIcon({ className = "size-3" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

/**
 * The padlock chip that stands where a locked player's controls would
 * be. Not a button and not greyed out: the player is fine, he just
 * cannot move. The reason is spoken, not only implied by the icon.
 */
export function LockBadge({ mode }: { mode: LockMode }) {
  return (
    <span className="badge-locked">
      <LockIcon />
      Locked
      <span className="sr-only">: {lockReason(mode)}</span>
    </span>
  );
}

function DroppedIcon({ className = "size-3" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      <circle cx="6" cy="5.5" r="2.4" />
      <path d="M2 14c0-2.3 1.8-3.8 4-3.8s4 1.5 4 3.8" />
      <path d="M11.5 6h3" />
    </svg>
  );
}

/**
 * A row for somebody who is no longer on this roster.
 *
 * He was dropped after his game had kicked off, so the lock kept his
 * place in that week's lineup and his points still count for the team
 * (RosterEntry.onRoster false). Sits beside the padlock rather than
 * replacing it: both facts are true, and "locked" alone would read as an
 * ordinary starter. The word is the badge, so none of this depends on
 * seeing the colour or the glyph.
 */
export function DroppedBadge() {
  return (
    <span className="badge-dropped">
      <DroppedIcon />
      Dropped
      <span className="sr-only">
        : no longer on this roster, but his points still count for this week
      </span>
    </span>
  );
}

/**
 * The one line that explains a Dropped row, written once per screen
 * rather than once per player.
 *
 * Without it a manager sees a man he knows he dropped sitting in his
 * starting lineup and scoring, which looks like a bug. `mine` is the
 * manager's own team ("your lineup"); every other roster is somebody
 * else's.
 */
export function DroppedNote({
  count,
  mine = false,
}: {
  count: number;
  /** This roster belongs to the signed-in manager. */
  mine?: boolean;
}) {
  if (count < 1) return null;
  const one = count === 1;
  const whose = mine ? "your" : "this team's";

  return (
    <p className="note-neutral">
      <DroppedIcon className="mt-0.5 size-3.5" />
      <span>
        <span className="font-semibold text-foreground">
          {one ? "1 dropped player is" : `${count} dropped players are`} still
          in {whose} lineup.
        </span>{" "}
        {one
          ? "He was dropped after his game had kicked off, so he is no longer on the roster"
          : "They were dropped after their games had kicked off, so they are no longer on the roster"}{" "}
        &mdash;{" "}
        {one
          ? "but he keeps his place for the week and his points still count."
          : "but they keep their places for the week and their points still count."}
      </span>
    </p>
  );
}

export interface GameStatus {
  label: string;
  tone: "live" | "final" | "upcoming" | "off";
}

/**
 * The player's NFL game in a few characters: "Live 14-10" (his team's
 * score first), "Final 24-17", "Sun 1:00 PM", "Postponed".
 *
 * Kickoff is written in the league's timezone rather than the browser's
 * so the server and client render the same text. There is no quarter or
 * clock in nfl_games, so a game in progress reads "Live".
 */
export function gameStatus(
  game: NflGame | null,
  teamAbbr: string | null,
  timeZone: string,
): GameStatus | null {
  if (!game) return null;

  const home = game.home_team === teamAbbr;
  const mine = home ? game.home_score : game.away_score;
  const theirs = home ? game.away_score : game.home_score;
  const score = mine != null && theirs != null ? ` ${mine}-${theirs}` : "";

  switch (game.status) {
    case "in_progress":
      return { label: `Live${score}`, tone: "live" };
    case "final":
      return { label: `Final${score}`, tone: "final" };
    case "postponed":
      return { label: "Postponed", tone: "off" };
    default:
      return game.kickoff_at
        ? { label: kickoffLabel(game.kickoff_at, timeZone), tone: "upcoming" }
        : null;
  }
}

function kickoffLabel(iso: string, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  };
  let text: string;
  try {
    text = new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(
      new Date(iso),
    );
  } catch {
    text = new Intl.DateTimeFormat("en-US", {
      ...options,
      timeZone: "America/New_York",
    }).format(new Date(iso));
  }
  // ICU puts a narrow no-break space before AM/PM in some versions and
  // not others; one plain space keeps server and client text identical.
  return text.replace(/\s+/g, " ").replace(",", "");
}

/** The status, coloured by tone but always carrying its own words. */
export function GameStatusText({ status }: { status: GameStatus | null }) {
  if (!status) return null;
  return (
    <span
      className={
        status.tone === "live"
          ? "font-semibold text-foreground"
          : status.tone === "off"
            ? "text-negative"
            : undefined
      }
    >
      {status.label}
    </span>
  );
}

/**
 * The league's lock rule in one or two sentences, with how much of this
 * lineup it has caught so far.
 */
export function lockRuleText(mode: LockMode): string {
  return mode === "weekly_kickoff"
    ? "The whole lineup locks at the first kickoff of the week. From then until next week, nobody moves into or out of the starting lineup."
    : "Each player locks when his own game kicks off. A locked player can't move into or out of the starting lineup; everyone else can be moved until his game starts.";
}
