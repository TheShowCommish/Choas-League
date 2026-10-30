import Link from "next/link";
import { getLeagueContext } from "@/lib/league";
import { positionLabel } from "@/lib/roster-slots";
import {
  defenseRank,
  ordinal,
  pointsAllowed,
} from "@/lib/defense-vs-position";
import {
  fetchFacingRows,
  fetchTeamName,
} from "@/lib/defense-vs-position-server";
import { Headshot } from "../players/player-bits";
import {
  DIFFICULTY_CHIP,
  DIFFICULTY_TEXT,
  DIFFICULTY_WORD,
  difficultyTier,
} from "./difficulty";

/**
 * Points allowed: for one NFL defense and one position, every player of
 * that position who scored against it this season, by week, in this
 * league's scoring (T-089). Reached by clicking a starter's opponent on
 * My Team -- "my QB plays the Dolphins; what have QBs done to them?".
 *
 * Members-only through getLeagueContext, same privacy as compare/awards.
 */
export default async function DefensePage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string }>;
  searchParams: Promise<{ team?: string; pos?: string }>;
}) {
  const { leagueId } = await params;
  const sp = await searchParams;
  const { league } = await getLeagueContext(leagueId);

  const team = sp.team?.trim().toUpperCase() ?? "";
  const pos = sp.pos?.trim().toUpperCase() ?? "";

  // Nothing chosen: a plain prompt rather than an empty table. The page is
  // a drill-down into a specific matchup, so there is nothing to show until
  // one is named.
  if (!team || !pos) {
    return (
      <div className="space-y-5">
        <Header leagueId={leagueId} />
        <div className="card-tight border-dashed p-6 text-center">
          <p className="muted mx-auto max-w-sm">
            Pick a defense from a starter&rsquo;s opponent on My Team to see
            what their position has scored against it.
          </p>
        </div>
      </div>
    );
  }

  const [rows, teamName] = await Promise.all([
    fetchFacingRows(leagueId, league.season, pos),
    fetchTeamName(team),
  ]);

  const allowed = pointsAllowed(rows, team);
  const rank = defenseRank(rows, team);
  const posLabel = positionLabel(pos);

  return (
    <div className="space-y-5">
      <Header leagueId={leagueId} />

      <header>
        <h1 className="h1">
          {teamName} vs {posLabel}
        </h1>
        <p className="muted">
          Every {posLabel} who scored against {team} in {league.season}, by
          week, in this league&rsquo;s scoring. Scoreless weeks are left off.
        </p>
      </header>

      {rank &&
        (() => {
          const tier = difficultyTier(rank.rank, rank.teams);
          return (
            <div className="card flex flex-wrap items-center gap-x-5 gap-y-3">
              <div className="flex items-baseline gap-2">
                <span className={`score text-4xl ${DIFFICULTY_TEXT[tier]}`}>
                  {ordinal(rank.rank)}
                </span>
                <span className="muted text-sm">of {rank.teams} defenses</span>
              </div>
              <span
                className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${DIFFICULTY_CHIP[tier]}`}
              >
                {DIFFICULTY_WORD[tier]} matchup
              </span>
              <p className="muted basis-full text-sm md:basis-auto">
                {team} allows the {ordinal(rank.rank)}-most fantasy points to{" "}
                {posLabel} this season.
              </p>
              <span className="muted text-sm tabular-nums md:ml-auto">
                {rank.total.toFixed(1)} pts over {rank.games}{" "}
                {rank.games === 1 ? "game" : "games"} &middot;{" "}
                {rank.avg.toFixed(1)} avg
              </span>
            </div>
          );
        })()}

      {allowed.length === 0 ? (
        <div className="card-tight border-dashed p-6 text-center">
          <p className="muted mx-auto max-w-sm">
            No {posLabel} has scored against {team} yet this season.
          </p>
        </div>
      ) : (
        <>
          {/* Desktop: a table, newest week first. */}
          <div className="card-tight hidden overflow-hidden md:block">
            <table className="table">
              <thead>
                <tr>
                  <th className="pl-3">Week</th>
                  <th>Player</th>
                  <th className="pr-3 text-right">Pts</th>
                </tr>
              </thead>
              <tbody>
                {allowed.map((row) => (
                  <tr key={`${row.playerId}-${row.week}`}>
                    <td className="pl-3 whitespace-nowrap tabular-nums">
                      Wk {row.week}
                    </td>
                    <td>
                      <Link
                        href={`/l/${leagueId}/players/${row.playerId}`}
                        className="group flex items-center gap-2"
                      >
                        <Headshot
                          url={row.headshotUrl}
                          name={row.playerName}
                          size={28}
                        />
                        <span className="truncate font-medium group-hover:text-accent">
                          {row.playerName}
                        </span>
                      </Link>
                    </td>
                    <td className="pr-3 text-right">
                      <span className="score">{row.points.toFixed(1)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: a stacked card per week, so nothing scrolls sideways. */}
          <ul className="card-tight divide-y divide-border/60 overflow-hidden md:hidden">
            {allowed.map((row) => (
              <li
                key={`${row.playerId}-${row.week}`}
                className="flex items-center gap-3 px-3 py-2.5"
              >
                <Headshot
                  url={row.headshotUrl}
                  name={row.playerName}
                  size={36}
                />
                <Link
                  href={`/l/${leagueId}/players/${row.playerId}`}
                  className="min-w-0 flex-1"
                >
                  <span className="block truncate font-medium">
                    {row.playerName}
                  </span>
                  <span className="muted text-xs tabular-nums">
                    Week {row.week}
                  </span>
                </Link>
                <span className="score shrink-0 text-xl tabular-nums">
                  {row.points.toFixed(1)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Header({ leagueId }: { leagueId: string }) {
  return (
    <Link
      href={`/l/${leagueId}/my-team`}
      className="muted inline-flex items-center gap-1 text-sm hover:text-accent"
    >
      &larr; My Team
    </Link>
  );
}
