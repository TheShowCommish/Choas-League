import Link from "next/link";
import type { LineupHealth, LineupIssue } from "@/lib/roster-health";

/**
 * The roster-health banner (T-075): a nudge, before kickoff, that the
 * current week's starting lineup has a hole a manager can still fix --
 * an empty slot, a starter on a bye, or a starter ruled out.
 *
 * Tone is deliberately cautionary, not broken: an empty slot or a bye is
 * "needs attention" and wears the accent colour, the same family as
 * .note / .badge-todo. Only a ruled-out starter is the severe one, and
 * only that row turns negative/red -- the whole banner never does. The
 * caller decides whether to draw it at all (issues present AND the week
 * still actionable); this only renders what it is handed. `compact` is
 * the Home nudge -- one line and a link; the full form, on My Team, names
 * every problem.
 *
 * No "use client": both pages are server components.
 */

/** A warning triangle; decorative, the meaning is in the words beside it. */
function WarnIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

/**
 * One problem split into the parts the banner lays out: the slot it
 * concerns, the starter (or the fact there is none), and a short tag.
 * `severe` is the ruled-out case -- the only one that goes red.
 */
function issueParts(issue: LineupIssue): {
  slotLabel: string;
  who: string;
  tag: string;
  severe: boolean;
} {
  switch (issue.kind) {
    case "empty":
      return {
        slotLabel: issue.slotLabel,
        who: "No starter",
        tag: "Empty",
        severe: false,
      };
    case "bye":
      return {
        slotLabel: issue.slotLabel,
        who: issue.playerName ?? "",
        tag: "Bye",
        severe: false,
      };
    case "injury":
      return {
        slotLabel: issue.slotLabel,
        who: issue.playerName ?? "",
        tag: issue.detail ?? "Out",
        severe: true,
      };
  }
}

/** "1 issue" / "3 issues". */
function countLabel(count: number): string {
  return `${count} ${count === 1 ? "issue" : "issues"}`;
}

export function LineupHealthBanner({
  health,
  leagueId,
  compact = false,
}: {
  health: LineupHealth;
  leagueId: string;
  /** The Home nudge: one line and a link, rather than the full list. */
  compact?: boolean;
}) {
  if (health.count === 0) return null;

  // The Home nudge: a single accent-tinted bar, a 44px tap target, that
  // carries the count and sends the manager to My Team to fix it.
  if (compact) {
    return (
      <Link
        href={`/l/${leagueId}/my-team`}
        className="flex min-h-11 items-center gap-2 rounded-md border
          border-accent/40 bg-accent/10 px-3 text-sm font-medium text-accent
          transition-colors hover:bg-accent/15 focus-visible:outline-2
          focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <WarnIcon className="size-4 shrink-0" />
        <span className="min-w-0 truncate">
          Lineup needs attention &mdash; {countLabel(health.count)} this week
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          Review
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="size-4"
            aria-hidden="true"
          >
            <path d="m9 18 6-6-6-6" />
          </svg>
        </span>
      </Link>
    );
  }

  // The full form, on My Team: a titled accent banner with every problem
  // named -- slot, who, and a tag -- so the meaning survives without
  // colour. Only a ruled-out starter's tag turns red.
  return (
    <div
      className="space-y-2.5 rounded-md border border-accent/40 bg-accent/10
        px-3 py-3"
      role="status"
    >
      <p className="flex items-center gap-2 font-semibold text-foreground">
        <WarnIcon className="size-5 shrink-0 text-accent" />
        <span>Lineup needs attention</span>
        <span className="badge-todo ml-auto">{countLabel(health.count)}</span>
      </p>

      <ul className="space-y-1.5">
        {health.issues.map((issue, i) => {
          const { slotLabel, who, tag, severe } = issueParts(issue);
          return (
            <li
              key={`${issue.kind}-${issue.slotLabel}-${i}`}
              className="flex items-center gap-2 text-sm"
            >
              <span className="pill shrink-0 font-medium text-foreground">
                {slotLabel}
              </span>
              <span className="min-w-0 flex-1 truncate text-foreground">
                {who}
              </span>
              <span className={severe ? "badge-negative" : "badge-todo"}>
                {tag}
              </span>
            </li>
          );
        })}
      </ul>

      <p className="muted text-xs">Swap a starter below before kickoff.</p>
    </div>
  );
}
