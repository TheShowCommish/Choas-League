import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import type { League } from "@/lib/types";
import { LeagueForms } from "./forms";

interface MembershipRow {
  role: "commissioner" | "member";
  leagues: League | null;
}

export default async function LeaguesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: memberships } = await supabase
    .from("league_members")
    .select("role, leagues(*)")
    .order("joined_at", { ascending: true })
    .overrideTypes<MembershipRow[]>();

  const rows = (memberships ?? []).filter((m) => m.leagues !== null);

  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", user!.id)
    .single();

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">
      <header className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="h1">Your leagues</h1>
          <p className="muted">Signed in as {profile?.display_name ?? user?.email}</p>
        </div>
        <form action="/auth/signout" method="post">
          <button className="btn btn-sm">Sign out</button>
        </form>
      </header>

      {rows.length === 0 ? (
        <p className="card muted mb-6">
          You are not in a league yet. Create one, or join with a code.
        </p>
      ) : (
        <ul className="mb-8 space-y-3">
          {rows.map(({ role, leagues: league }) => (
            <li key={league!.id}>
              <Link
                href={`/l/${league!.id}`}
                className="card flex items-center justify-between gap-3 hover:border-accent"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{league!.name}</p>
                  <p className="muted">
                    {league!.season} &middot; Week {league!.current_week} &middot;{" "}
                    {league!.status.replace("_", " ")}
                  </p>
                </div>
                {role === "commissioner" && <span className="pill">Commish</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <LeagueForms />
    </main>
  );
}
