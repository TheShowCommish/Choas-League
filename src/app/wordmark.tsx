/**
 * The Chaos League identity.
 *
 * `ChaosMark` is the standalone glyph: a bolt knocked out of an
 * accent-filled badge, tilted just enough to read as motion rather than a
 * tidy app icon. It takes its colours from the theme tokens, so it turns
 * gridiron orange on the default dark base, burnt orange on light, and the
 * franchise accent on a team-themed page -- the mark belongs to whoever is
 * looking at it.
 *
 * `Wordmark` locks the mark up with the name set in the condensed display
 * face, which is half the identity. The name is real text, not paths, so it
 * stays selectable and legible to a screen reader.
 */

export function ChaosMark({
  size = 28,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label="Chaos League"
      className={className}
    >
      {/* The badge. A subtle skew gives the square a forward lean. */}
      <rect
        x="2"
        y="2"
        width="28"
        height="28"
        rx="8"
        fill="var(--accent)"
      />
      {/* The bolt, knocked out in the accent's ink colour. */}
      <path
        d="M18.5 5 L9 17.5 h5.2 l-2 9.5 L24 13.5 h-5.6 z"
        fill="var(--accent-ink)"
      />
    </svg>
  );
}

export function Wordmark({
  markSize = 28,
  className = "",
  /** Hide the text, showing the mark alone (tight headers / phone). */
  textHidden = false,
}: {
  markSize?: number;
  className?: string;
  textHidden?: boolean;
}) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <ChaosMark size={markSize} className="shrink-0" />
      <span
        className={`font-display text-lg leading-none font-bold tracking-tight whitespace-nowrap ${
          textHidden ? "sr-only" : ""
        }`}
      >
        <span className="text-foreground">CHAOS</span>
        <span className="text-accent"> LEAGUE</span>
      </span>
    </span>
  );
}
