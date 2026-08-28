import Link from "next/link";
import { getLeagueContext } from "@/lib/league";
import { createClient } from "@/lib/supabase/server";

const PAGE_SIZE = 60;

const TYPE_LABEL: Record<string, string> = {
  add: "Added",
  drop: "Dropped",
  waiver_add: "Waiver claim",
  waiver_failed: "Claim failed",
  trade: "Trade",
  draft: "Drafted",
  commissioner: "Commissioner",
};

const TYPE_COLOR: Record<string, string> = {
  add: "text-positive",
  waiver_add: "text-positive",
  draft: "text-accent",
  drop: "text-negative",
  waiver_failed: "text-muted",
};

interface Row {
  id: string;
  type: string;
  bid_amount: number | null;
  week: number;
  note: string;
  created_at: string;
  player_id: string | null;
  team_id: string | null;
  teams: { name: string } | null;
  nfl_players: { full_name: string; position: string | null } | null;
}

export default async function TransactionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string }>;
  searchParams: Promise<{ page?: string; type?: string; team?: string }>;
}) {
  const { leagueId } = await params;
  const sp = await searchParams;
  const { league, teams } = await getLeagueContext(leagueId);
  const supabase = await createClient();

  const page = Math.max(Number(sp.page) || 1, 1);
  const from = (page - 1) * PAGE_SIZE;

  let query = supabase
    .from("transactions")
    .select(
      "id, type, bid_amount, week, note, created_at, player_id, team_id, " +
        "teams(name), nfl_players(full_name, position)",
      { count: "exact" },
    )
    .eq("league_id", leagueId)
    .order("created_at", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);

  if (sp.type) query = query.eq("type", sp.type);
  if (sp.team) query = query.eq("team_id", sp.team);

  const { data, count } = await query;
  const rows = (data ?? []) as unknown as Row[];
  const pageCount = Math.max(Math.ceil((count ?? 0) / PAGE_SIZE), 1);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="h1">Transactions</h1>
        <p className="muted">
          Every roster move in {league.name}, newest first. Visible to the whole
          league.
        </p>
      </header>

      <form className="card grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="type">
            Type
          </label>
          <select id="type" name="type" className="input" defaultValue={sp.type ?? ""}>
            <option value="">All types</option>
            {Object.entries(TYPE_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label" htmlFor="team">
            Team
          </label>
          <select id="team" name="team" className="input" defaultValue={sp.team ?? ""}>
            <option value="">All teams</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-end">
          <button className="btn w-full">Filter</button>
        </div>
      </form>

      {rows.length === 0 ? (
        <p className="card muted">Nothing here yet.</p>
      ) : (
        <ul className="card-tight divide-y divide-border/60">
          {rows.map((row) => (
            <li key={row.id} className="flex items-start gap-3 p-3">
              <span
                className={`w-24 shrink-0 text-xs font-medium ${
                  TYPE_COLOR[row.type] ?? "text-muted"
                }`}
              >
                {TYPE_LABEL[row.type] ?? row.type}
              </span>

              <div className="min-w-0 flex-1">
                <p className="text-sm">
                  <span className="font-medium">
                    {row.teams?.name ?? "League"}
                  </span>{" "}
                  {row.player_id ? (
                    <Link
                      href={`/l/${leagueId}/players/${row.player_id}`}
                      className="hover:text-accent"
                    >
                      {row.nfl_players?.full_name ?? row.player_id}
                    </Link>
                  ) : null}
                  {row.nfl_players?.position && (
                    <span className="muted"> ({row.nfl_players.position})</span>
                  )}
                  {row.bid_amount != null && row.bid_amount > 0 && (
                    <span className="muted"> · ${row.bid_amount}</span>
                  )}
                </p>
                {row.note && <p className="muted text-xs">{row.note}</p>}
              </div>

              <time
                className="muted shrink-0 text-xs"
                dateTime={row.created_at}
              >
                {new Date(row.created_at).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
              </time>
            </li>
          ))}
        </ul>
      )}

      {pageCount > 1 && (
        <nav className="flex items-center justify-between gap-3">
          {page > 1 ? (
            <Link href={pageHref(sp, page - 1)} className="btn btn-sm">
              &larr; Newer
            </Link>
          ) : (
            <span />
          )}
          <span className="muted text-sm">
            {page} / {pageCount}
          </span>
          {page < pageCount ? (
            <Link href={pageHref(sp, page + 1)} className="btn btn-sm">
              Older &rarr;
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </div>
  );
}

function pageHref(sp: Record<string, string | undefined>, page: number) {
  const query = new URLSearchParams(
    Object.entries(sp).filter(([, v]) => v) as [string, string][],
  );
  query.set("page", String(page));
  return `?${query}`;
}
