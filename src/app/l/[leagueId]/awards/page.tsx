import { getLeagueContext } from "@/lib/league";
import { createClient } from "@/lib/supabase/server";
import { awardsByWeek } from "@/lib/weekly-awards";
import { WeekTrophies } from "./awards-block";
import { fetchAwardMatchups } from "./data";

/**
 * Season awards (T-076): every finalized week's trophies, newest first.
 * Always-on in v1 -- a per-league on/off toggle would need a stored
 * commissioner setting (a migration), deferred as a follow-up.
 */
export default async function AwardsPage({
  params,
}: {
  params: Promise<{ leagueId: string }>;
}) {
  const { leagueId } = await params;
  const { league, teams } = await getLeagueContext(leagueId);
  const supabase = await createClient();

  const matchups = await fetchAwardMatchups(supabase, leagueId, league.season);
  const weeks = awardsByWeek(matchups);

  const nameById = new Map(teams.map((t) => [t.id, t.name]));
  const teamName = (id: string) => nameById.get(id) ?? "?";

  return (
    <div className="space-y-5">
      <header>
        <h1 className="h1">Awards</h1>
        <p className="muted">Weekly trophies from every finalized week.</p>
      </header>

      {weeks.length === 0 ? (
        <div className="card flex flex-col items-center gap-2 py-10 text-center">
          <span className="flex size-10 items-center justify-center rounded-full bg-surface-2 text-muted">
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
              <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
              <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
              <path d="M4 22h16" />
              <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
              <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
              <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
            </svg>
          </span>
          <p className="font-medium">No awards yet</p>
          <p className="muted max-w-xs">
            Trophies appear here once the first week is finalized.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {weeks.map((entry) => (
            <section key={entry.week} className="space-y-2">
              <div className="flex items-center gap-2">
                <h2 className="h2">Week {entry.week}</h2>
                <span className="h-px flex-1 bg-border" aria-hidden="true" />
              </div>
              <WeekTrophies entry={entry} teamName={teamName} />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
