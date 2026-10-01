import Link from "next/link";
import { notFound } from "next/navigation";
import { getLeagueContext } from "@/lib/league";
import { getTeamRoster } from "@/lib/roster";
import { createClient } from "@/lib/supabase/server";
import { TeamCrest, TeamTheme } from "../../team-theme";
import { WeekPicker } from "../../week-picker";
import { positionLabel } from "@/lib/roster-slots";
import { LineupOverride } from "./lineup-override";
import {
  GameStatusText,
  LockBadge,
  gameStatus,
  type LockMode,
} from "../../lineup-lock";

export default async function TeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string; teamId: string }>;
  searchParams: Promise<{ week?: string }>;
}) {
  const { leagueId, teamId } = await params;
  const { week: weekParam } = await searchParams;
  const { league, teams, rosterSlots, myTeam, isCommissioner } =
    await getLeagueContext(leagueId);

  const team = teams.find((t) => t.id === teamId);
  if (!team) notFound();

  const week = Number(weekParam) || league.current_week;
  const lastWeek = Math.max(league.regular_season_weeks + 4, week);

  const supabase = await createClient();
  const [roster, { data: owner }] = await Promise.all([
    getTeamRoster(leagueId, teamId, league.season, week),
    team.owner_id
      ? supabase
          .from("profiles")
          .select("display_name")
          .eq("id", team.owner_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const starterKeys = new Set(
    rosterSlots.filter((s) => s.is_starter).map((s) => s.slot_key),
  );

  const starters = roster.filter(
    (r) => r.slotKey && starterKeys.has(r.slotKey),
  );
  const bench = roster.filter((r) => !r.slotKey || !starterKeys.has(r.slotKey));
  const total = starters.reduce((sum, r) => sum + r.points, 0);

  const tableProps = {
    leagueId,
    lockMode: league.lineup_lock_mode,
    timeZone: league.timezone,
  };

  return (
    <div className="space-y-4">
    {/* The whole page wears the team's colours, so flicking between two
        rosters is obvious at a glance rather than a matter of reading the
        heading each time. */}
    <TeamTheme
      color={team.color}
      secondary={team.secondary_color}
      className="space-y-4"
    >
      <header className="card-tight overflow-hidden">
        <div
          className="h-1.5 w-full"
          style={{
            background: `linear-gradient(90deg, var(--team), var(--team-2))`,
          }}
        />
        <div className="flex flex-wrap items-center gap-4 p-4">
          <TeamCrest
            logoUrl={team.logo_url}
            abbreviation={team.abbreviation}
            name={team.name}
            color={team.color}
            secondary={team.secondary_color}
            size={56}
          />
          <div className="min-w-0 flex-1">
            {team.city && <p className="muted text-sm">{team.city}</p>}
            <h1 className="h1">{team.name}</h1>
            <p className="muted">
              {owner?.display_name ?? "Unclaimed"} &middot; $
              {team.faab_remaining} FAAB &middot;{" "}
              {roster.filter((r) => r.onRoster).length} players
            </p>
          </div>
          <WeekPicker
            week={week}
            lastWeek={lastWeek}
            currentWeek={league.current_week}
          />
        </div>
      </header>

      <div className="flex flex-wrap gap-2">
        {team.id === myTeam?.id ? (
          <Link
            href={`/l/${leagueId}/my-team?week=${week}`}
            className="btn btn-sm"
          >
            Edit this lineup
          </Link>
        ) : (
          myTeam && (
            <Link
              href={`/l/${leagueId}/trades?with=${team.id}`}
              className="btn btn-sm btn-primary"
            >
              Find a trade with {team.name}
            </Link>
          )
        )}
      </div>

      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="h2">Starters</h2>
          <span className="tabular-nums">{total.toFixed(1)} pts</span>
        </div>
        <RosterTable {...tableProps} entries={starters} showSlot />
      </section>

      <section>
        <h2 className="h2 mb-2">Bench</h2>
        <RosterTable {...tableProps} entries={bench} showSlot={false} />
      </section>
    </TeamTheme>

      {/* Outside the team's colours on purpose: this is the league's
          tool, not the team's, and the team accent can be too dark to
          read on the page. */}
      {/* `roster` is what the week holds, not just what the team owns, so
          a team whose only remaining row is a dropped locked starter --
          exactly the lineup a commissioner is asked to fix -- still gets
          the panel. */}
      {isCommissioner && roster.length > 0 && (
        <LineupOverride
          leagueId={leagueId}
          teamId={team.id}
          teamName={team.name}
          week={week}
          players={roster.map((r) => ({
            id: r.playerId,
            name: r.player.full_name,
            position: r.player.position,
            slotKey: r.slotKey,
            locked: r.locked,
          }))}
          slots={rosterSlots.map((s) => ({
            key: s.slot_key,
            label: s.label === s.slot_key ? s.label : `${s.label} (${s.slot_key})`,
            isStarter: s.is_starter,
          }))}
        />
      )}
    </div>
  );
}

function RosterTable({
  leagueId,
  entries,
  showSlot,
  lockMode,
  timeZone,
}: {
  leagueId: string;
  entries: Awaited<ReturnType<typeof getTeamRoster>>;
  showSlot: boolean;
  lockMode: LockMode;
  timeZone: string;
}) {
  if (entries.length === 0) {
    return <p className="card muted">Nobody here.</p>;
  }

  return (
    <div className="card-tight table-scroll">
      <table className="table">
        <thead>
          <tr>
            {showSlot && <th className="w-14">Slot</th>}
            <th>Player</th>
            <th className="w-px">
              <span className="sr-only">Lock</span>
            </th>
            <th className="text-right">Pts</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr
              key={entry.playerId}
              className={entry.locked ? "bg-surface-2/50" : undefined}
            >
              {showSlot && (
                <td className="text-xs text-muted">{entry.slotKey}</td>
              )}
              <td>
                <Link
                  href={`/l/${leagueId}/players/${entry.playerId}`}
                  className="block font-medium hover:text-accent"
                >
                  {entry.player.full_name}
                </Link>
                <span className="muted text-xs tabular-nums">
                  {positionLabel(entry.player.position)} &middot;{" "}
                  {entry.player.team_abbr ?? "FA"} &middot;{" "}
                  {entry.game ? entry.opponent : "BYE"}
                  {entry.game && (
                    <>
                      {" · "}
                      <GameStatusText
                        status={gameStatus(
                          entry.game,
                          entry.player.team_abbr,
                          timeZone,
                        )}
                      />
                    </>
                  )}
                </span>
              </td>
              <td className="w-px text-right">
                {entry.locked && <LockBadge mode={lockMode} />}
              </td>
              <td className="text-right tabular-nums">
                {entry.points.toFixed(1)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
