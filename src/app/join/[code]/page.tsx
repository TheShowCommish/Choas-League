import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * The invite link. `/join/A1B2C3D4` adds you to the league and drops you
 * on the team board to pick a slot.
 *
 * Signed-out visitors never reach this: the proxy bounces them to
 * /login?next=/join/<code> and they arrive back here afterwards.
 */
export default async function JoinPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const supabase = await createClient();

  const { data: leagueId, error } = await supabase.rpc(
    "join_league_as_member",
    { p_join_code: code },
  );

  if (error) {
    return (
      <main className="mx-auto w-full max-w-sm flex-1 px-4 py-12">
        <h1 className="h1 mb-2">That invite did not work</h1>
        <p className="error-box mb-4">{error.message}</p>
        <p className="muted mb-4">
          Check the link with whoever sent it, or join with the code by hand.
        </p>
        <Link href="/leagues" className="btn btn-primary">
          Your leagues
        </Link>
      </main>
    );
  }

  // Already have a team here? The board would only bounce you again.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: team } = await supabase
    .from("teams")
    .select("id")
    .eq("league_id", leagueId)
    .eq("owner_id", user!.id)
    .maybeSingle();

  redirect(team ? `/l/${leagueId}/my-team` : `/l/${leagueId}/claim`);
}
