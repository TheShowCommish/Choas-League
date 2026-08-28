import { headers } from "next/headers";
import { requireCommissioner } from "@/lib/league";
import { createClient } from "@/lib/supabase/server";
import type { Draft, Profile, ScoringRule, StatDefinition } from "@/lib/types";
import { AdminTabs, type IngestRun } from "./tabs";

export default async function AdminPage({
  params,
}: {
  params: Promise<{ leagueId: string }>;
}) {
  const { leagueId } = await params;
  const { league, teams, rosterSlots } = await requireCommissioner(leagueId);

  // The invite link needs an absolute URL. Reading it here rather than
  // from window in the client keeps the markup identical on both sides
  // of hydration.
  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host");
  const protocol =
    headerList.get("x-forwarded-proto") ??
    (host?.startsWith("localhost") ? "http" : "https");
  const origin = host ? `${protocol}://${host}` : "";
  const supabase = await createClient();

  const [{ data: stats }, { data: rules }, { data: members }, { data: draft }] =
    await Promise.all([
      supabase
        .from("stat_definitions")
        .select("*")
        .eq("scorable", true)
        .order("sort_order"),
      supabase
        .from("league_scoring_rules")
        .select("*")
        .eq("league_id", leagueId),
      supabase
        .from("league_members")
        .select("user_id, role, profiles(id, display_name, email)")
        .eq("league_id", leagueId),
      supabase.from("drafts").select("*").eq("league_id", leagueId).maybeSingle(),
    ]);

  const { data: limits } = await supabase
    .from("league_position_limits")
    .select("position, max_count")
    .eq("league_id", leagueId);

  const positionLimits = Object.fromEntries(
    (limits ?? []).map((l) => [l.position as string, l.max_count as number]),
  );

  // Ingestion health: whether the stat jobs are actually running, which
  // is the first thing to check when scores look wrong.
  const { data: runs } = await supabase
    .from("ingest_runs")
    .select("id, job, season, week, status, rows_written, message, started_at")
    .order("started_at", { ascending: false })
    .limit(10);

  const memberProfiles = (members ?? []).map((m) => {
    const profile = m.profiles as unknown as Pick<
      Profile,
      "id" | "display_name" | "email"
    >;
    return { ...profile, role: m.role as string };
  });

  return (
    <div className="space-y-4">
      <header>
        <h1 className="h1">Commissioner tools</h1>
        <p className="muted">
          Join code: <strong className="font-mono">{league.join_code}</strong>
        </p>
      </header>

      <AdminTabs
        league={league}
        teams={teams}
        rosterSlots={rosterSlots}
        stats={(stats ?? []) as StatDefinition[]}
        rules={(rules ?? []) as ScoringRule[]}
        members={memberProfiles}
        draft={(draft ?? null) as Draft | null}
        ingestRuns={(runs ?? []) as IngestRun[]}
        origin={origin}
        positionLimits={positionLimits}
      />
    </div>
  );
}
