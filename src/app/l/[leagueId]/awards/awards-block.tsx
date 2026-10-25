import type {
  MarginAward,
  TeamScoreAward,
  WeekAwards,
} from "@/lib/weekly-awards";

/**
 * Weekly trophies, on the Chaos design system (T-076). One block per
 * finalized week; used for the single latest week on Home and for the full
 * season list on the awards page. Team ids are resolved to names by the
 * caller, which already has the league's teams loaded.
 *
 * Presentation notes:
 *  - Four cards in a 2x2 grid on phones (no sideways scroll at 375px) and a
 *    4-across strip from `lg` up, so the block sits as a tidy row under the
 *    Home dashboard and reads the same on the season page.
 *  - Each trophy carries a distinct glyph and a tone. The high score and the
 *    two margin trophies are "hot" (accent); the low score is the lone dim
 *    "toilet" (muted, never harsh red), so it visually loses at a glance.
 *  - All colour comes from theme tokens (accent / muted / foreground), so the
 *    block stays legible in dark, light and team themes.
 */

function pts(n: number): string {
  return Number(n).toFixed(1);
}

/** Small, emoji-free line glyphs (currentColor) so each trophy reads fast. */
type GlyphName = "trophy" | "toilet" | "blowout" | "closest";

function Glyph({ name }: { name: GlyphName }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: "size-4",
    "aria-hidden": true,
  };
  switch (name) {
    case "trophy": // high score: the cup
      return (
        <svg {...common}>
          <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
          <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
          <path d="M4 22h16" />
          <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
          <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
          <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
        </svg>
      );
    case "toilet": // low score: trending into the basement
      return (
        <svg {...common}>
          <path d="M16 17h6v-6" />
          <path d="M22 17 13.5 8.5 8.5 13.5 2 7" />
        </svg>
      );
    case "blowout": // biggest blowout: the bolt
      return (
        <svg {...common}>
          <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
        </svg>
      );
    case "closest": // closest game: two sides pressed together
      return (
        <svg {...common}>
          <path d="m20 17-5-5 5-5" />
          <path d="m4 7 5 5-5 5" />
        </svg>
      );
  }
}

/** The label row: a tinted glyph chip and the uppercase trophy name. */
function TrophyHead({
  glyph,
  label,
  tone,
}: {
  glyph: GlyphName;
  label: string;
  tone: "accent" | "muted";
}) {
  const chip =
    tone === "accent"
      ? "bg-accent/15 text-accent"
      : "bg-surface-2 text-muted";
  return (
    <div className="flex items-center gap-2">
      <span
        className={`flex size-6 shrink-0 items-center justify-center rounded-md ${chip}`}
      >
        <Glyph name={glyph} />
      </span>
      <span className="text-xs font-semibold tracking-wide text-muted uppercase">
        {label}
      </span>
    </div>
  );
}

function ScoreTrophy({
  glyph,
  label,
  tone,
  award,
  teamName,
}: {
  glyph: GlyphName;
  label: string;
  tone: "accent" | "muted";
  award: TeamScoreAward;
  teamName: (id: string) => string;
}) {
  return (
    <li className="card-tight flex flex-col gap-1.5 px-3 py-2.5">
      <TrophyHead glyph={glyph} label={label} tone={tone} />
      <p className="truncate text-sm font-medium" title={teamName(award.teamId)}>
        {teamName(award.teamId)}
      </p>
      <p
        className={`score mt-auto text-2xl ${
          tone === "accent" ? "text-accent" : "text-muted"
        }`}
      >
        {pts(award.points)}
      </p>
    </li>
  );
}

function MarginTrophy({
  glyph,
  label,
  award,
  teamName,
}: {
  glyph: GlyphName;
  label: string;
  award: MarginAward;
  teamName: (id: string) => string;
}) {
  const winner = teamName(award.winnerTeamId);
  const loser = teamName(award.loserTeamId);
  return (
    <li className="card-tight flex flex-col gap-1.5 px-3 py-2.5">
      <TrophyHead glyph={glyph} label={label} tone="accent" />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium" title={winner}>
          {winner}
        </p>
        <p className="muted truncate text-xs" title={`def. ${loser}`}>
          def. {loser}
        </p>
      </div>
      <div className="mt-auto flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="score text-lg">
          {pts(award.winnerScore)}
          <span className="text-muted">{"–"}</span>
          {pts(award.loserScore)}
        </span>
        <span className="badge-weeks">+{pts(award.margin)}</span>
      </div>
    </li>
  );
}

/** The four trophies for one week. */
export function WeekTrophies({
  entry,
  teamName,
}: {
  entry: WeekAwards;
  teamName: (id: string) => string;
}) {
  const { awards } = entry;
  return (
    <ul className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {awards.highScore && (
        <ScoreTrophy
          glyph="trophy"
          label="High score"
          tone="accent"
          award={awards.highScore}
          teamName={teamName}
        />
      )}
      {awards.lowScore && (
        <ScoreTrophy
          glyph="toilet"
          label="Low score (toilet)"
          tone="muted"
          award={awards.lowScore}
          teamName={teamName}
        />
      )}
      {awards.blowout && (
        <MarginTrophy
          glyph="blowout"
          label="Biggest blowout"
          award={awards.blowout}
          teamName={teamName}
        />
      )}
      {awards.closest && (
        <MarginTrophy
          glyph="closest"
          label="Closest game"
          award={awards.closest}
          teamName={teamName}
        />
      )}
    </ul>
  );
}
