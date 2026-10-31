import Link from "next/link";
import { getLeagueContext } from "@/lib/league";
import { getRecentNotifications } from "@/lib/notifications-server";
import { markAllRead, markRead } from "./actions";

/**
 * The notification centre list (T-072). Reached from the header bell.
 * Plain server-rendered markup with mark-read forms; the designer owns
 * turning the bell into a dropdown and styling this screen.
 */
export default async function NotificationsPage({
  params,
}: {
  params: Promise<{ leagueId: string }>;
}) {
  const { leagueId } = await params;
  // Membership is enforced here (404s a non-member) as well as by RLS.
  await getLeagueContext(leagueId);

  const notifications = await getRecentNotifications(leagueId);
  const hasUnread = notifications.some((n) => n.read_at === null);

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="h1">Notifications</h1>
          <p className="muted">Trades, waivers and finalized matchups.</p>
        </div>
        {hasUnread && (
          <form action={markAllRead.bind(null, leagueId)}>
            <button className="btn btn-sm" type="submit">
              Mark all read
            </button>
          </form>
        )}
      </header>

      {notifications.length === 0 ? (
        <p className="card muted">No notifications yet.</p>
      ) : (
        <ul className="space-y-2">
          {notifications.map((n) => {
            const unread = n.read_at === null;
            return (
              <li
                key={n.id}
                className={`card flex items-start justify-between gap-3 ${
                  unread ? "border-accent" : ""
                }`}
              >
                <Link href={n.link || `/l/${leagueId}`} className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {unread && (
                      <span
                        className="mr-2 inline-block size-2 rounded-full bg-accent align-middle"
                        aria-hidden="true"
                      />
                    )}
                    {n.title}
                  </p>
                  {n.body && <p className="muted text-sm">{n.body}</p>}
                  <p className="muted mt-1 text-xs">
                    {new Date(n.created_at).toLocaleString()}
                  </p>
                </Link>
                {unread && (
                  <form action={markRead.bind(null, leagueId, n.id)}>
                    <button className="btn btn-sm" type="submit">
                      Mark read
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
