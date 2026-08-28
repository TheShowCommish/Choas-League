import Link from "next/link";
import { getLeagueContext } from "@/lib/league";
import { createClient } from "@/lib/supabase/server";
import { LeagueNav } from "./nav";

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
  const { data: draft } = await supabase
    .from("drafts")
    .select("status")
    .eq("league_id", leagueId)
    .maybeSingle();

  const showDraft =
    isCommissioner || (draft !== null && draft.status !== "complete");

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <Link href={`/l/${leagueId}`} className="block truncate font-semibold">
              {league.name}
            </Link>
            <p className="muted text-xs">
              {league.season} &middot; Week {league.current_week}
              {myTeam && <> &middot; {myTeam.name}</>}
            </p>
          </div>
          <form action="/auth/signout" method="post">
            <button className="btn btn-sm">Sign out</button>
          </form>
        </div>

        <LeagueNav
          leagueId={leagueId}
          isCommissioner={isCommissioner}
          showDraft={showDraft}
        />
      </header>

      {/* pb-24 leaves room for the fixed bottom nav on phones. */}
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-5 pb-24 md:pb-8">
        {children}
      </main>
    </div>
  );
}
