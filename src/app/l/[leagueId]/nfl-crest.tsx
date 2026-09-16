import { nflLogoUrl } from "@/lib/nfl-teams";

/**
 * An NFL club's crest, sized for a table row.
 *
 * Never next/image: the file is served from ESPN's CDN and would have
 * to be added to the remote allow-list, and a page of fifty rows would
 * then put fifty optimisation requests through the server for artwork
 * that never changes. A plain img with fixed dimensions is cheaper and
 * cannot shift the layout.
 *
 * A player with no club -- a free agent, or a name a feed gave us
 * without a team -- gets the same shaped badge saying so, rather than a
 * gap where the other rows have a logo.
 */
export function NflCrest({
  abbr,
  size = 20,
}: {
  abbr: string | null;
  size?: number;
}) {
  const src = nflLogoUrl(abbr);

  if (!src) {
    return (
      <span
        title="Not on an NFL roster"
        className="inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-surface-2 font-semibold text-muted"
        style={{ width: size, height: size, fontSize: size * 0.42 }}
      >
        FA
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={`${abbr} logo`}
      width={size}
      height={size}
      loading="lazy"
      className="shrink-0 object-contain"
      style={{ width: size, height: size }}
    />
  );
}

/**
 * The badge a player wears when no fantasy team has him: the same
 * footprint as a team crest, so the column stays a column.
 */
export function FreeAgentCrest({
  size = 20,
  label = "FA",
  title = "Free agent",
}: {
  size?: number;
  label?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="inline-flex shrink-0 items-center justify-center rounded border border-dashed border-positive/60 font-semibold text-positive"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {label}
    </span>
  );
}
