import Link from "next/link";
import { notFound } from "next/navigation";
import { getLeagueContext } from "@/lib/league";
import { getTeamRoster, type RosterEntry } from "@/lib/roster";
import { createClient } from "@/lib/supabase/server";
import { expandSlots } from "@/lib/roster-slots";
import type { Matchup } from "@/lib/types";

export default async function MatchupPage({
  params,
}: {
  params: Promise<{ leagueId: string; matchupId: string }>;
}) {
  const { leagueId, matchupId } = await params;
  const { league, teams, rosterSlots } = await getLeagueContext(leagueId);
  const supabase = await createClient();

  const { data } = await supabase
    .from("matchups")
    .select("*")
    .eq("id", matchupId)
    .maybeSingle();

  if (!data) notFound();
  const matchup = data as Matchup;

  const home = teams.find((t) => t.id === matchup.home_team_id);
  const away = matchup.away_team_id
    ? teams.find((t) => t.id === matchup.away_team_id)
    : null;

  if (!home) notFound();

  const [homeRoster, awayRoster] = await Promise.all([
    getTeamRoster(leagueId, home.id, league.season, matchup.week),
    away
      ? getTeamRoster(leagueId, away.id, league.season, matchup.week)
      : Promise.resolve([]),
  ]);

  // One row per individual starting spot: a 2-RB league gets two RB rows.
  const starterSpots = expandSlots(rosterSlots).filter((s) => s.isStarter);

  const homeBySlot = groupBySlot(homeRoster);
  const awayBySlot = groupBySlot(awayRoster);

  return (
    <div className="space-y-4">
      <Link href={`/l/${leagueId}/matchups?week=${matchup.week}`} className="muted text-sm">
        &larr; Week {matchup.week}
      </Link>

      <header className="card">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{away?.name ?? "Bye"}</p>
            <p className="text-2xl font-semibold tabular-nums">
              {Number(matchup.away_score).toFixed(1)}
            </p>
          </div>
          <span className="muted text-xs">
            {matchup.status === "final" ? "FINAL" : `WK ${matchup.week}`}
          </span>
          <div className="min-w-0 flex-1 text-right">
            <p className="truncate text-sm">{home.name}</p>
            <p className="text-2xl font-semibold tabular-nums">
              {Number(matchup.home_score).toFixed(1)}
            </p>
          </div>
        </div>
      </header>

      {!away ? (
        <p className="card muted">{home.name} has a bye this week.</p>
      ) : (
        <div className="card-tight divide-y divide-border">
          {starterSpots.map((spot, index) => {
            // Nth spot of this slot type on each side.
            const nth = starterSpots
              .slice(0, index)
              .filter((s) => s.slotKey === spot.slotKey).length;

            return (
              <MatchupRow
                key={spot.key}
                label={spot.label}
                leagueId={leagueId}
                home={homeBySlot.get(spot.slotKey)?.[nth]}
                away={awayBySlot.get(spot.slotKey)?.[nth]}
              />
            );
          })}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <BenchList
          title={`${away?.name ?? home.name} bench`}
          leagueId={leagueId}
          entries={away ? benchOf(awayRoster, rosterSlots) : []}
        />
        <BenchList
          title={`${home.name} bench`}
          leagueId={leagueId}
          entries={benchOf(homeRoster, rosterSlots)}
        />
      </div>
    </div>
  );
}

function groupBySlot(roster: RosterEntry[]) {
  const map = new Map<string, RosterEntry[]>();
  for (const entry of roster) {
    if (!entry.slotKey) continue;
    const list = map.get(entry.slotKey) ?? [];
    list.push(entry);
    map.set(entry.slotKey, list);
  }
  return map;
}

function benchOf(
  roster: RosterEntry[],
  slots: { slot_key: string; is_starter: boolean }[],
) {
  const starterKeys = new Set(
    slots.filter((s) => s.is_starter).map((s) => s.slot_key),
  );
  return roster.filter((r) => !r.slotKey || !starterKeys.has(r.slotKey));
}

function MatchupRow({
  label,
  leagueId,
  home,
  away,
}: {
  label: string;
  leagueId: string;
  home?: RosterEntry;
  away?: RosterEntry;
}) {
  return (
    <div className="flex items-center gap-2 px-2 py-2 text-sm">
      <PlayerCell entry={away} leagueId={leagueId} align="left" />
      <span className="w-14 shrink-0 text-center text-xs text-muted">
        {label}
      </span>
      <PlayerCell entry={home} leagueId={leagueId} align="right" />
    </div>
  );
}

function PlayerCell({
  entry,
  leagueId,
  align,
}: {
  entry?: RosterEntry;
  leagueId: string;
  align: "left" | "right";
}) {
  if (!entry) {
    return (
      <div className={`min-w-0 flex-1 text-muted ${align === "right" ? "text-right" : ""}`}>
        <span className="text-xs">Empty</span>
      </div>
    );
  }

  return (
    <div className={`min-w-0 flex-1 ${align === "right" ? "text-right" : ""}`}>
      <Link
        href={`/l/${leagueId}/players/${entry.playerId}`}
        className="block truncate hover:text-accent"
      >
        {entry.player.full_name}
      </Link>
      <span className="muted block text-xs">
        {entry.player.position ?? "?"} &middot;{" "}
        {entry.game ? entry.opponent : "BYE"} &middot;{" "}
        <span className="tabular-nums">{entry.points.toFixed(1)}</span>
      </span>
    </div>
  );
}

function BenchList({
  title,
  leagueId,
  entries,
}: {
  title: string;
  leagueId: string;
  entries: RosterEntry[];
}) {
  if (entries.length === 0) return null;

  return (
    <details className="card-tight">
      <summary className="cursor-pointer p-3 text-sm font-medium">
        {title}
      </summary>
      <ul className="divide-y divide-border/60 border-t border-border">
        {entries.map((entry) => (
          <li
            key={entry.playerId}
            className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
          >
            <Link
              href={`/l/${leagueId}/players/${entry.playerId}`}
              className="min-w-0 truncate hover:text-accent"
            >
              {entry.player.full_name}
              <span className="muted ml-2 text-xs">
                {entry.player.position ?? "?"}
              </span>
            </Link>
            <span className="muted tabular-nums">
              {entry.points.toFixed(1)}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
