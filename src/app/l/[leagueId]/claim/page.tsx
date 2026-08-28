import { redirect } from "next/navigation";
import { getLeagueContext } from "@/lib/league";
import { createClient } from "@/lib/supabase/server";
import { ClaimBoard } from "./claim-board";

/**
 * The team board: every slot in the league, taken or free.
 *
 * This is where an invite link lands a new manager. Teams exist from the
 * moment the league is created, so joining is a matter of picking one
 * rather than adding another.
 */
export default async function ClaimPage({
  params,
}: {
  params: Promise<{ leagueId: string }>;
}) {
  const { leagueId } = await params;
  const { league, myTeam, teams } = await getLeagueContext(leagueId);

  // Already have one? Nothing to choose.
  if (myTeam) redirect(`/l/${leagueId}/my-team`);

  const supabase = await createClient();
  const { data: owners } = await supabase
    .from("profiles")
    .select("id, display_name")
    .in(
      "id",
      teams.map((t) => t.owner_id).filter((id): id is string => !!id),
    );

  const ownerNames = new Map(
    (owners ?? []).map((o) => [o.id as string, o.display_name as string]),
  );

  const free = teams.filter((t) => t.owner_id === null);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="h1">Choose your team</h1>
        <p className="muted">
          {free.length} of {teams.length} still free in {league.name}. Pick one
          and it is yours for the season -- the name, colour and logo are all
          yours to change afterwards.
        </p>
      </header>

      {free.length === 0 ? (
        <p className="card muted">
          Every team has a manager. Ask the commissioner to make room, or to
          hand you one from the admin tools.
        </p>
      ) : (
        <ClaimBoard
          leagueId={leagueId}
          teams={teams.map((t) => ({
            id: t.id,
            name: t.name,
            color: t.color,
            logoUrl: t.logo_url,
            slotNumber: t.slot_number,
            ownerName: t.owner_id ? (ownerNames.get(t.owner_id) ?? "Taken") : null,
          }))}
        />
      )}
    </div>
  );
}
