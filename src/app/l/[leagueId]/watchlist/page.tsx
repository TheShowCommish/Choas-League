import Link from "next/link";
import { getLeagueContext } from "@/lib/league";
import { getWatchlist } from "@/lib/watchlist-server";
import { watchAvailabilityLabel } from "@/lib/watchlist";
import type { WatchlistEntry } from "@/lib/types";
import { positionLabel } from "@/lib/roster-slots";
import { NflCrest } from "../nfl-crest";
import { AvailabilityChip, Headshot } from "../players/player-bits";
import { WatchToggle } from "../players/watch-toggle";

/**
 * The watchlist view (T-074): the signed-in user's starred players, with
 * where each can be had and his next fixture. A dedicated route (like
 * /compare, /awards) keeps the Players pool RPC untouched and carries the
 * same per-league privacy.
 */
export default async function WatchlistPage({
  params,
}: {
  params: Promise<{ leagueId: string }>;
}) {
  const { leagueId } = await params;
  // Membership is enforced here (404s a non-member) as well as by RLS.
  const { userId } = await getLeagueContext(leagueId);

  const entries = await getWatchlist(leagueId, userId);

  return (
    <div className="space-y-5">
      <header>
        <Link href={`/l/${leagueId}/players`} className="muted text-sm">
          &larr; All players
        </Link>
        <h1 className="h1 mt-1">Watchlist</h1>
        <p className="muted">
          Players you are keeping an eye on, with where they can be had and
          their next game. Only you can see your watchlist.
        </p>
      </header>

      {entries.length === 0 ? (
        <EmptyState leagueId={leagueId} />
      ) : (
        <>
          <p className="muted text-sm">
            {entries.length} {entries.length === 1 ? "player" : "players"}
          </p>

          {/* Desktop: a row per watched player. */}
          <div className="card-tight table-scroll hidden md:block">
            <table className="table">
              <thead>
                <tr>
                  <th className="w-10" />
                  <th>Player</th>
                  <th>Pos</th>
                  <th>Team</th>
                  <th>Availability</th>
                  <th>Next</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.playerId}>
                    <td>
                      <WatchToggle
                        leagueId={leagueId}
                        playerId={e.playerId}
                        initialWatching
                        playerName={e.fullName}
                        size={18}
                      />
                    </td>
                    <td>
                      <Link
                        href={`/l/${leagueId}/players/${e.playerId}`}
                        className="flex min-w-0 items-center gap-2.5 font-medium hover:text-accent"
                      >
                        <Headshot
                          url={e.headshotUrl}
                          name={e.fullName}
                          size={28}
                        />
                        <span className="truncate">{e.fullName}</span>
                      </Link>
                    </td>
                    <td className="text-xs">{positionLabel(e.pos)}</td>
                    <td className="text-xs">
                      <span className="flex items-center gap-1.5">
                        <NflCrest abbr={e.teamAbbr} />
                        <span>{e.teamAbbr ?? "FA"}</span>
                      </span>
                    </td>
                    <td className="text-xs">
                      <WatchAvailability entry={e} />
                    </td>
                    <td className="whitespace-nowrap text-xs">
                      <NextFixture opponent={e.nextOpponent} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: a card per watched player. The star is a sibling of the
              Link so unwatching never opens the player page. */}
          <ul className="space-y-2 md:hidden">
            {entries.map((e) => (
              <li
                key={e.playerId}
                className="card-tight flex items-center gap-2 p-3"
              >
                <Link
                  href={`/l/${leagueId}/players/${e.playerId}`}
                  className="flex min-w-0 flex-1 items-center gap-3"
                >
                  <Headshot url={e.headshotUrl} name={e.fullName} size={40} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{e.fullName}</p>
                    <p className="muted truncate text-xs">
                      {positionLabel(e.pos)}
                      {e.teamAbbr ? ` · ${e.teamAbbr}` : ""}
                      {" · "}
                      {e.nextOpponent ? `vs ${e.nextOpponent}` : "BYE"}
                    </p>
                    <div className="mt-1.5">
                      <WatchAvailability entry={e} />
                    </div>
                  </div>
                </Link>
                <WatchToggle
                  leagueId={leagueId}
                  playerId={e.playerId}
                  initialWatching
                  playerName={e.fullName}
                  size={20}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * The availability chip, reusing the Players tab's component so a watched
 * player reads the same here as he does in the pool. The list carries only
 * the owner's name (not a resolved Team), so an owned player takes the
 * neutral "Rostered by X" chip; waivers and free agents take the same
 * accent / positive chips the pool uses.
 */
function WatchAvailability({ entry }: { entry: WatchlistEntry }) {
  return (
    <AvailabilityChip
      team={null}
      ownerName={
        entry.availability === "owned"
          ? watchAvailabilityLabel(entry.availability, entry.ownerName)
          : null
      }
      onWaivers={entry.availability === "waivers"}
    />
  );
}

/** Next week's opponent, with a bye flagged the way the Players tab flags it. */
function NextFixture({ opponent }: { opponent: string | null }) {
  if (!opponent) return <span className="text-negative">BYE</span>;
  return <span>vs {opponent}</span>;
}

/**
 * Nothing starred yet: an outline star over a short line on how to add one,
 * so the empty page still says what the feature is for.
 */
function EmptyState({ leagueId }: { leagueId: string }) {
  return (
    <div className="card-tight flex flex-col items-center gap-3 border-dashed px-6 py-10 text-center">
      <span
        aria-hidden
        className="inline-flex size-12 items-center justify-center rounded-full border border-border bg-surface-2 text-muted"
      >
        <svg
          viewBox="0 0 24 24"
          width={24}
          height={24}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.15 1 5.85L12 17.9l-5.25 2.75 1-5.85L3.5 9.7l5.9-.9Z" />
        </svg>
      </span>
      <div className="space-y-1">
        <p className="font-display text-lg font-semibold tracking-tight">
          No players on your watchlist yet
        </p>
        <p className="muted mx-auto max-w-sm">
          Tap the star on any player &mdash; on the Players tab or a
          player&rsquo;s page &mdash; to follow him here.
        </p>
      </div>
      <Link href={`/l/${leagueId}/players`} className="btn btn-sm mt-1">
        Browse players
      </Link>
    </div>
  );
}
