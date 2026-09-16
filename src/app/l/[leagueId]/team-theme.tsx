import type { CSSProperties, ReactNode } from "react";

/**
 * Paints a subtree in one team's colours.
 *
 * Tailwind's accent colour resolves through a CSS variable
 * (`--color-accent: var(--accent)` in globals.css), so overriding
 * `--accent` here is enough to retheme every `bg-accent`,
 * `text-accent` and `border-accent` inside -- no per-element styles, no
 * duplicated class lists, and nothing outside the wrapper is touched.
 *
 * `--team` and `--team-2` are the raw pair, for the few places that
 * want both at once: the header wash, a logo backdrop, a divider.
 */
export function TeamTheme({
  color,
  secondary,
  className,
  children,
}: {
  color: string;
  secondary: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={className}
      style={
        {
          "--accent": color,
          "--team": color,
          "--team-2": secondary,
        } as CSSProperties
      }
    >
      {children}
    </div>
  );
}

/**
 * A team's logo, or its initials on its own colours when it has none.
 *
 * Never next/image: a logo is whatever URL the manager pasted or
 * uploaded, and the host is not known ahead of time, so it cannot be
 * put through an allow-list of remote patterns.
 */
export function TeamCrest({
  logoUrl,
  abbreviation,
  name,
  color,
  secondary,
  size = 56,
}: {
  logoUrl: string | null;
  abbreviation: string;
  name: string;
  color: string;
  secondary: string;
  size?: number;
}) {
  const label = (abbreviation || name.slice(0, 3)).toUpperCase();

  return logoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={logoUrl}
      alt={`${name} logo`}
      width={size}
      height={size}
      className="shrink-0 rounded-lg border border-border object-contain"
      style={{ width: size, height: size, backgroundColor: color }}
    />
  ) : (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-lg border border-border font-bold text-white"
      style={{
        width: size,
        height: size,
        fontSize: size / 3.2,
        background: `linear-gradient(135deg, ${color}, ${secondary})`,
      }}
    >
      {label}
    </span>
  );
}
