import "server-only";

import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { League, RosterSlot, Team } from "@/lib/types";

/**
 * Everything a page inside /l/[leagueId] needs to know about who is
 * looking at it. RLS already hides leagues you are not in, so a missing
 * row here means "not a member" as much as "does not exist" -- both are
 * a 404 as far as the visitor is concerned.
 */
export interface LeagueContext {
  league: League;
  userId: string;
  isCommissioner: boolean;
  /** The signed-in user's team in this league, if they have one. */
  myTeam: Team | null;
  teams: Team[];
  rosterSlots: RosterSlot[];
}

export async function getLeagueContext(
  leagueId: string,
): Promise<LeagueContext> {
  const supabase = await createClient();

  // getClaims() verifies the session JWT -- locally, with no round trip to
  // the auth server, when the project uses asymmetric signing keys (it
  // falls back to a server call on legacy symmetric keys, i.e. no worse
  // than getUser). The signature is still checked, so the identity is as
  // trustworthy as getUser's, and every query below is RLS-guarded anyway.
  // This runs on all 25 league pages, so dropping the auth-server hop here
  // takes a serial cross-region round trip off every one of them.
  const { data: claimsData } = await supabase.auth.getClaims();
  const userId = claimsData?.claims.sub;
  if (!userId) redirect("/login");

  const [{ data: league }, { data: membership }, { data: teams }, { data: slots }] =
    await Promise.all([
      supabase.from("leagues").select("*").eq("id", leagueId).maybeSingle(),
      supabase
        .from("league_members")
        .select("role")
        .eq("league_id", leagueId)
        .eq("user_id", userId)
        .maybeSingle(),
      supabase
        .from("teams")
        .select("*")
        .eq("league_id", leagueId)
        .order("name"),
      supabase
        .from("roster_slots")
        .select("*")
        .eq("league_id", leagueId)
        .order("order_index"),
    ]);

  if (!league || !membership) notFound();

  const teamList = (teams ?? []) as Team[];

  return {
    league: league as League,
    userId,
    isCommissioner: membership.role === "commissioner",
    myTeam: teamList.find((t) => t.owner_id === userId) ?? null,
    teams: teamList,
    rosterSlots: (slots ?? []) as RosterSlot[],
  };
}

/** Same, but 404s anyone who is not the commissioner. */
export async function requireCommissioner(
  leagueId: string,
): Promise<LeagueContext> {
  const ctx = await getLeagueContext(leagueId);
  if (!ctx.isCommissioner) notFound();
  return ctx;
}
