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

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: league }, { data: membership }, { data: teams }, { data: slots }] =
    await Promise.all([
      supabase.from("leagues").select("*").eq("id", leagueId).maybeSingle(),
      supabase
        .from("league_members")
        .select("role")
        .eq("league_id", leagueId)
        .eq("user_id", user.id)
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
    userId: user.id,
    isCommissioner: membership.role === "commissioner",
    myTeam: teamList.find((t) => t.owner_id === user.id) ?? null,
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
