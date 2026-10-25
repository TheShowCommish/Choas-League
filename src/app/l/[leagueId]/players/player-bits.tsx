import type { Team } from "@/lib/types";
import { TeamCrest } from "../team-theme";

/**
 * A player's headshot, sized for a row or a card.
 *
 * Plain <img>, never next/image: the file is served from ESPN's CDN (the
 * same reasoning as the club crests) and a page of fifty would otherwise
 * put fifty optimisation requests through the server for artwork that
 * never changes. Fixed width/height so a missing or slow image cannot
 * shift the layout, and a graceful initials fallback when the feed gave
 * us no portrait. Decorative: the name sits beside it as real text, so
 * the image is aria-hidden rather than repeating it.
 */
export function Headshot({
  url,
  name,
  size = 28,
}: {
  url: string | null;
  name: string;
  size?: number;
}) {
  if (url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt=""
        aria-hidden
        width={size}
        height={size}
        loading="lazy"
        className="shrink-0 rounded-full border border-border bg-surface-2 object-cover"
        style={{ width: size, height: size }}
      />
    );
  }

  const initials =
    name
      .split(/\s+/)
      .map((part) => part[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?";

  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-surface-2 font-semibold text-muted"
      style={{ width: size, height: size, fontSize: size * 0.36 }}
    >
      {initials}
    </span>
  );
}

/**
 * Who, if anyone, has this player: the owning club's crest and name, or a
 * coloured chip that says he is there for the taking.
 *
 * Colour carries the state at a glance down a long list -- green for a
 * free agent, accent for the waiver window, a neutral crest for taken --
 * and the word repeats it for anyone who can't tell the three apart.
 */
export function AvailabilityChip({
  team,
  ownerName,
  onWaivers,
}: {
  team: Team | null;
  ownerName: string | null;
  onWaivers: boolean;
}) {
  if (team) {
    return (
      <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs text-muted">
        <TeamCrest
          logoUrl={team.logo_url}
          abbreviation={team.abbreviation}
          name={team.name}
          color={team.color}
          secondary={team.secondary_color}
          size={16}
        />
        <span className="truncate">{team.name}</span>
      </span>
    );
  }

  // A team the league context could not resolve -- removed mid-season, say.
  if (ownerName) {
    return (
      <span className="inline-flex items-center rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs text-muted">
        {ownerName}
      </span>
    );
  }

  if (onWaivers) {
    return (
      <span className="inline-flex shrink-0 items-center rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-accent">
        Waivers
      </span>
    );
  }

  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-positive/40 bg-positive/10 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-positive">
      Free agent
    </span>
  );
}
