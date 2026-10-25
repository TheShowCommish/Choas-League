/*
 * Shared trade-impact presentation (T-073).
 *
 * The propose screen and the inbox both drive their decision support off the
 * same `TradeImpact` numbers, so they render through the same block here --
 * one visual language for "what does this trade do to each lineup". Pure
 * presentation: it reads the figures `trade-impact.ts` computed and shows
 * them; it decides nothing about the trade itself.
 */
import type { Legality, TeamImpact, TradeImpact } from "@/lib/trade-impact";

/**
 * The impact block for one trade: each team's best starting lineup before and
 * after, the change, and whether the post-trade roster is legal. Side by side
 * from the sm breakpoint up (proposing team first); stacked on a phone.
 */
export function TradeImpactBlock({
  proposingName,
  receivingName,
  impact,
  className = "",
}: {
  proposingName: string;
  receivingName: string;
  impact: TradeImpact;
  className?: string;
}) {
  return (
    <section className={`space-y-2 ${className}`} aria-label="Trade impact">
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">
        Projected starting lineup{" "}
        <span className="font-normal normal-case">· best lineup, season-avg based</span>
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3">
        <TeamImpactCell name={proposingName} side={impact.proposing} />
        <TeamImpactCell name={receivingName} side={impact.receiving} />
      </div>
    </section>
  );
}

/** One team's before -> after projected total, the change, and legality. */
function TeamImpactCell({ name, side }: { name: string; side: TeamImpact }) {
  return (
    <div className="rounded-lg border border-border/60 bg-surface-2/50 p-2.5">
      <p className="mb-1 truncate text-sm font-medium" title={name}>
        {name}
      </p>
      {/* after and the delta carry the eye; before is the quiet starting point. */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="sr-only">Before </span>
        <span className="muted text-sm tabular-nums">{side.before.toFixed(1)}</span>
        <span aria-hidden className="muted text-sm">
          &rarr;
        </span>
        <span className="sr-only">after </span>
        <span className="score text-2xl leading-none">
          {side.after.toFixed(1)}
        </span>
        <DeltaChip delta={side.delta} />
      </div>
      <LegalityNote legality={side.legality} />
    </div>
  );
}

/** The change, as a chip: green for a gain, red for a loss, quiet at zero. */
function DeltaChip({ delta }: { delta: number }) {
  const tone =
    delta > 0
      ? "border-positive/40 bg-positive/10 text-positive"
      : delta < 0
        ? "border-negative/40 bg-negative/10 text-negative"
        : "border-border bg-surface-2 text-muted";
  // toFixed carries the minus for a loss; a gain needs the plus added.
  const sign = delta > 0 ? "+" : "";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold tabular-nums ${tone}`}
    >
      <span className="sr-only">change </span>
      {sign}
      {delta.toFixed(1)}
    </span>
  );
}

/**
 * Whether the post-trade roster is legal. A clean trade gets a quiet, positive
 * "Fits roster"; an illegal one spells out exactly what is over -- the roster
 * cap as "size/capacity", and each position as "POS count/max" -- in the
 * negative colour, loud enough to stop the manager sending it.
 */
function LegalityNote({ legality }: { legality: Legality }) {
  if (legality.legal) {
    return (
      <p className="mt-1.5 flex items-center gap-1 text-xs font-medium text-positive/80">
        <span aria-hidden>&#10003;</span> Fits roster
      </p>
    );
  }
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1" role="alert">
      <span className="text-xs font-semibold text-negative">Won&rsquo;t fit:</span>
      {legality.overCapacity && (
        <span className="badge-negative">
          Roster {legality.rosterSize}/{legality.rosterCapacity}
        </span>
      )}
      {legality.positionOver.map((v) => (
        <span key={v.position} className="badge-negative">
          {v.position} {v.count}/{v.max}
        </span>
      ))}
    </div>
  );
}

/**
 * A traded player's decision-support value: his season average as the primary
 * figure, his next-week projection muted beside it. Shared by both screens so
 * "X.X avg · Y.Y proj" reads the same everywhere.
 */
export function PlayerValue({
  avg,
  projection,
  className = "",
}: {
  avg: number;
  projection: number | null;
  className?: string;
}) {
  return (
    <span className={`tabular-nums ${className}`}>
      <span className="font-semibold text-foreground">{avg.toFixed(1)}</span>
      <span className="text-muted"> avg</span>
      {projection != null && (
        <span className="text-muted"> · {projection.toFixed(1)} proj</span>
      )}
    </span>
  );
}
