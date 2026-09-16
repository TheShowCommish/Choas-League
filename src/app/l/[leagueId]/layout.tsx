import { getLeagueContext } from "@/lib/league";
import { createClient } from "@/lib/supabase/server";
import type { League } from "@/lib/types";
import { TeamThemeVars } from "@/app/theme";
import { ThemeSwitch } from "@/app/theme-switch";
import { LeagueMain } from "./main-width";
import { LeagueSwitcher, type LeagueOption } from "./league-switcher";
import { LeagueNav } from "./nav";

interface MembershipRow {
  role: "commissioner" | "member";
  leagues: Pick<League, "id" | "name" | "season"> | null;
}

export default async function LeagueLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ leagueId: string }>;
}) {
  const { leagueId } = await params;
  const { league, isCommissioner, myTeam } = await getLeagueContext(leagueId);

  // The draft room stays out of the nav until there is a draft to go to,
  // so nobody has a dead link sitting there for eleven months of the
  // year. The commissioner always sees it, to set it up.
  const supabase = await createClient();
  const [{ data: draft }, { data: memberships }] = await Promise.all([
    supabase
      .from("drafts")
      .select("status")
      .eq("league_id", leagueId)
      .maybeSingle(),
    // Every league this manager is in, for the header switcher. RLS
    // already limits league_members to their own rows.
    supabase
      .from("league_members")
      .select("role, leagues(id, name, season)")
      .order("joined_at", { ascending: true })
      .overrideTypes<MembershipRow[]>(),
  ]);

  const showDraft =
    isCommissioner || (draft !== null && draft.status !== "complete");

  const leagues: LeagueOption[] = (memberships ?? [])
    .filter((m) => m.leagues !== null)
    .map((m) => ({
      id: m.leagues!.id,
      name: m.leagues!.name,
      season: m.leagues!.season,
      isCommissioner: m.role === "commissioner",
    }));

  return (
    <div className="flex min-h-full flex-col">
      {/*
        The team theme's colours. Inert unless that theme is picked, so
        this renders the same on every page whatever the manager chose.
        A visitor without a team in this league falls back to the site
        accent rather than to nothing.
      */}
      <TeamThemeVars
        color={myTeam?.color ?? "#4f8ef7"}
        secondary={myTeam?.secondary_color ?? "#2a5db0"}
      />

      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <LeagueSwitcher
              current={{
                id: league.id,
                name: league.name,
                season: league.season,
                isCommissioner,
              }}
              leagues={leagues}
            />
            <p className="muted text-xs">
              {league.season} &middot; Week {league.current_week}
              {myTeam && <> &middot; {myTeam.name}</>}
            </p>
          </div>

          {/* Phones find these in the bottom nav's More sheet instead, and
              get the header row back for the league name. */}
          <div className="hidden shrink-0 items-center gap-2 md:flex">
            <ThemeSwitch />
            <form action="/auth/signout" method="post">
              <button className="btn btn-sm">Sign out</button>
            </form>
          </div>
        </div>

        <LeagueNav
          leagueId={leagueId}
          isCommissioner={isCommissioner}
          showDraft={showDraft}
        />
      </header>

      <LeagueMain>{children}</LeagueMain>
    </div>
  );
}
