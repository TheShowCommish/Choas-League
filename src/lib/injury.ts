/**
 * Turning an injury row into something a manager can act on.
 *
 * A bare designation is not an answer. "Questionable" next to a name
 * tells you there is a chance he does not play; it does not tell you
 * what is wrong, and it certainly does not tell you whether to look for
 * a replacement this week or for the next two months. These helpers put
 * the three things that matter together: what it is, how bad, and how
 * long it is likely to last.
 *
 * Pure, so both the server pages and the client draft room can use it.
 */

/** How loudly to draw the badge. */
export type InjuryTone = "out" | "doubtful" | "questionable" | "note";

export interface InjurySummary {
  /** The designation itself, tidied: "Questionable", "IR", "Out". */
  label: string;
  tone: InjuryTone;
  /** What is hurt, if known: "Knee", "Hamstring". */
  bodyPart: string | null;
  /** One line on how long this is expected to last. */
  outlook: string;
  /** Whatever detail the feed carried, verbatim. */
  notes: string | null;
  /** Practice participation, tidied: "Did Not Participate". */
  practice: string | null;
  /** How many days he has carried this, if the feed dated it. */
  daysOut: number | null;
}

/** The fields any caller has to be able to supply. */
export interface InjuryFields {
  injury_status: string | null;
  injury_body_part?: string | null;
  injury_notes?: string | null;
  injury_start_date?: string | null;
  practice_participation?: string | null;
}

/**
 * How long each designation usually means, in plain words.
 *
 * Deliberately not a number of games. Only IR and PUP carry a rule that
 * fixes one -- everything else is a probability, and dressing a
 * probability up as "out 1 game" would be inventing precision the feed
 * does not have.
 */
const OUTLOOK: Record<string, { tone: InjuryTone; outlook: string }> = {
  ir: {
    tone: "out",
    outlook: "On injured reserve — out at least four games, often the season.",
  },
  "injured reserve": {
    tone: "out",
    outlook: "On injured reserve — out at least four games, often the season.",
  },
  pup: {
    tone: "out",
    outlook: "On the PUP list — out at least four games once the season starts.",
  },
  nfi: { tone: "out", outlook: "Non-football injury list — out indefinitely." },
  sus: { tone: "out", outlook: "Suspended — unavailable until it is served." },
  out: { tone: "out", outlook: "Ruled out for this week's game." },
  dnr: { tone: "out", outlook: "Did not report — unavailable." },
  doubtful: {
    tone: "doubtful",
    outlook: "Doubtful — historically about one in four play.",
  },
  questionable: {
    tone: "questionable",
    outlook: "Questionable — a real chance he plays, decided close to kickoff.",
  },
  probable: {
    tone: "note",
    outlook: "Probable — expected to play.",
  },
  limited: {
    tone: "questionable",
    outlook: "Limited in practice — worth checking again before kickoff.",
  },
};

/** Title Case, for feeds that shout or mumble. */
function tidy(value: string): string {
  return value
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function describeInjury(
  player: InjuryFields,
  now = new Date(),
): InjurySummary | null {
  const raw = player.injury_status?.trim();
  if (!raw) return null;

  const key = raw.toLowerCase();
  const known = OUTLOOK[key];

  const bodyPart = player.injury_body_part?.trim()
    ? tidy(player.injury_body_part.trim())
    : null;

  let daysOut: number | null = null;
  if (player.injury_start_date) {
    const started = new Date(player.injury_start_date);
    if (!Number.isNaN(started.getTime())) {
      const days = Math.floor(
        (now.getTime() - started.getTime()) / (1000 * 60 * 60 * 24),
      );
      if (days >= 0) daysOut = days;
    }
  }

  const base =
    known?.outlook ??
    `Carrying a "${tidy(raw)}" designation — check the latest report.`;

  // A long-running injury says more about the timeline than the
  // designation does, so it is worth adding rather than replacing.
  const duration =
    daysOut !== null && daysOut >= 7
      ? ` Hurt ${daysOut >= 60 ? `${Math.round(daysOut / 30)} months` : `${daysOut} days`} now.`
      : "";

  return {
    label: raw.length <= 4 ? raw.toUpperCase() : tidy(raw),
    tone: known?.tone ?? "note",
    bodyPart,
    outlook: base + duration,
    notes: player.injury_notes?.trim() || null,
    practice: player.practice_participation?.trim()
      ? tidy(player.practice_participation.trim())
      : null,
    daysOut,
  };
}

/** Tailwind classes for a badge at each severity. */
export const INJURY_CLASS: Record<InjuryTone, string> = {
  out: "border-negative bg-negative/15 text-negative",
  doubtful: "border-negative/60 bg-negative/10 text-negative",
  questionable: "border-amber-500/60 bg-amber-500/10 text-amber-400",
  note: "border-border bg-surface-2 text-muted",
};
