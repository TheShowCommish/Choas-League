/**
 * The league nav's icons, drawn inline.
 *
 * A dozen small outline glyphs did not justify an icon package. They
 * share one 24px grid and one stroke so they read as a set, and take
 * their colour from the text around them, which is how the active tab
 * turns accent without any icon knowing it is active.
 */

export type NavIconName =
  | "home"
  | "team"
  | "matchups"
  | "players"
  | "more"
  | "trades"
  | "standings"
  | "log"
  | "chat"
  | "draft"
  | "admin"
  | "close";

const PATHS: Record<NavIconName, React.ReactNode> = {
  home: (
    <>
      <path d="M3.5 10.5 12 3.5l8.5 7" />
      <path d="M5.5 9v11h13V9" />
      <path d="M10 20v-5.5h4V20" />
    </>
  ),
  // A jersey: the team you manage.
  team: (
    <path d="M8.5 3.5 4 5.5 2.5 10l3 1.5 1-2V20.5h11V9.5l1 2 3-1.5L20 5.5l-4.5-2c-.5 1.5-1.8 2.5-3.5 2.5s-3-1-3.5-2.5Z" />
  ),
  // Two sides facing off.
  matchups: (
    <>
      <path d="M4 7.5h12.5" />
      <path d="m13.5 4 3.5 3.5-3.5 3.5" />
      <path d="M20 16.5H7.5" />
      <path d="M10.5 13 7 16.5l3.5 3.5" />
    </>
  ),
  players: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.5-3.5 3.2-5.5 6.5-5.5s6 2 6.5 5.5" />
      <path d="M15.5 4.8a3.5 3.5 0 0 1 0 6.4" />
      <path d="M18 14.8c2 .7 3.2 2.5 3.5 5.2" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.25" fill="currentColor" />
      <circle cx="12" cy="12" r="1.25" fill="currentColor" />
      <circle cx="19" cy="12" r="1.25" fill="currentColor" />
    </>
  ),
  trades: (
    <>
      <path d="M4 8h14" />
      <path d="m15 4.5 3.5 3.5-3.5 3.5" />
      <path d="M20 16H6" />
      <path d="M9 12.5 5.5 16 9 19.5" />
    </>
  ),
  standings: (
    <>
      <path d="M4 20.5V13h4.5v7.5" />
      <path d="M8.5 20.5V8.5h7v12" />
      <path d="M15.5 20.5V11.5H20v9" />
      <path d="M3 20.5h18" />
    </>
  ),
  log: (
    <>
      <path d="M9 6h11" />
      <path d="M9 12h11" />
      <path d="M9 18h11" />
      <circle cx="4.5" cy="6" r="1" fill="currentColor" />
      <circle cx="4.5" cy="12" r="1" fill="currentColor" />
      <circle cx="4.5" cy="18" r="1" fill="currentColor" />
    </>
  ),
  chat: (
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v10a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V17h0A1.5 1.5 0 0 1 4 15.5Z" />
  ),
  // A draft board: a clipboard with picks on it.
  draft: (
    <>
      <path d="M9 4.5H6.5A1.5 1.5 0 0 0 5 6v13.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H15" />
      <rect x="9" y="3" width="6" height="3" rx="1" />
      <path d="M8.5 11h7" />
      <path d="M8.5 15h7" />
    </>
  ),
  admin: (
    <>
      <path d="M4 7h9" />
      <path d="M17 7h3" />
      <circle cx="15" cy="7" r="2" />
      <path d="M4 17h3" />
      <path d="M11 17h9" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  close: (
    <>
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </>
  ),
};

export function NavIcon({
  name,
  className = "size-6",
}: {
  name: NavIconName;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {PATHS[name]}
    </svg>
  );
}
