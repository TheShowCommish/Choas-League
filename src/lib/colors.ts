/**
 * Team colours come out of a form managers type into, and end up inside
 * inline styles and a stylesheet. This is the boundary where a stray
 * `;}` would otherwise stop being a colour and start being CSS.
 */

const DEFAULT = "#4f8ef7";

/** A '#rrggbb' colour, or the site accent if it is anything else. */
export function safeColor(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  return /^#[0-9a-f]{3,8}$/i.test(trimmed) ? trimmed : DEFAULT;
}

/**
 * The same colour at a given strength over whatever is behind it.
 * Used for the washes that mark whose half of a matchup you are looking
 * at: strong enough to read as a team, faint enough to read text on, in
 * either the light or the dark theme.
 */
export function tint(value: string | null | undefined, percent: number): string {
  return `color-mix(in srgb, ${safeColor(value)} ${percent}%, transparent)`;
}
