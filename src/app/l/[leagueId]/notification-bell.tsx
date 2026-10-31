import Link from "next/link";

/**
 * Header bell and unread badge for the notification centre (T-072).
 *
 * Deliberately minimal: a link to the notifications list with a count.
 * The ESPN/Yahoo pattern is a dropdown from the bell -- that is the
 * designer's to build on top of this placeholder; the data and the route
 * it points at already work.
 */
export function NotificationBell({
  leagueId,
  unread,
}: {
  leagueId: string;
  unread: number;
}) {
  const label =
    unread > 0 ? `Notifications, ${unread} unread` : "Notifications";

  return (
    <Link
      href={`/l/${leagueId}/notifications`}
      aria-label={label}
      className="relative inline-flex size-9 items-center justify-center rounded-md text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-5"
        aria-hidden="true"
      >
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      {unread > 0 && (
        <span className="absolute -right-0.5 -top-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-4 text-white">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );
}
