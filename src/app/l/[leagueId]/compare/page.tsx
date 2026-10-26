import Link from "next/link";
import { getLeagueContext } from "@/lib/league";
import { createClient } from "@/lib/supabase/server";
import { positionLabel } from "@/lib/roster-slots";
import {
  buildCompareRows,
  parsePlayerParam,
  type ComparePlayer,
} from "@/lib/compare";
import { Headshot } from "../players/player-bits";
import { ComparePicker, type PickerPlayer } from "./compare-picker";

/** How many pool matches the picker offers for a search. */
const RESULT_LIMIT = 12;

interface PlayerRow {
  id: string;
  full_name: string;
  position: string | null;
  team_abbr: string | null;
  headshot_url: string | null;
}

interface ScoreRow {
  player_id: string;
  week: number;
  points: number;
}

export default async function ComparePage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string }>;
  searchParams: Promise<{ players?: string; q?: string }>;
}) {
  const { leagueId } = await params;
  const sp = await searchParams;
  const { league } = await getLeagueContext(leagueId);
  const supabase = await createClient();

  const ids = parsePlayerParam(sp.players);
  const search = sp.q?.trim() ?? "";
  const lastWeek = Math.max(league.current_week - 1, 1);

  // Load the chosen players' basics and season scores in one round trip
  // each; the per-player projection RPC is the player page's sibling read,
  // so each number lines up with that page. Everything is scoped to this
  // league-season, like the Players tab.
  const [{ data: playerRows }, { data: scoreRows }, { data: poolMatches }] =
    await Promise.all([
      ids.length
        ? supabase
            .from("nfl_players")
            .select("id, full_name, position, team_abbr, headshot_url")
            .in("id", ids)
        : Promise.resolve({ data: [] as PlayerRow[] }),
      ids.length
        ? supabase
            .from("player_week_scores")
            .select("player_id, week, points")
            .eq("league_id", leagueId)
            .eq("season", league.season)
            .in("player_id", ids)
        : Promise.resolve({ data: [] as ScoreRow[] }),
      // The picker's search over the pool: availability 'all' because a
      // compare is research, not a pickup -- you compare rostered players too.
      search
        ? supabase.rpc("league_player_pool", {
            p_league: leagueId,
            p_search: search,
            p_position: null,
            p_availability: "all",
            p_sort: "points",
            p_limit: RESULT_LIMIT,
            p_offset: 0,
            p_team: null,
            p_dir: "desc",
          })
        : Promise.resolve({ data: [] }),
    ]);

  const byId = new Map(
    ((playerRows ?? []) as PlayerRow[]).map((p) => [p.id, p] as const),
  );

  // The weekly projection is best-effort, exactly like the player page: an
  // unofficial feed cannot decide whether this page renders. Only this
  // league-season has scored projections, which is all compare reads.
  const projections = new Map<string, number | null>();
  const nextOpponents = new Map<string, string | null>();
  await Promise.all(
    ids
      .filter((id) => byId.has(id))
      .flatMap((id) => [
        supabase
          .rpc("projected_points", {
            p_league: leagueId,
            p_player: id,
            p_season: league.season,
            p_week: league.current_week,
          })
          .then((r) =>
            projections.set(id, r.error ? null : (r.data as number | null)),
          ),
        supabase
          .from("player_week_projections")
          .select("opponent")
          .eq("player_id", id)
          .eq("season", league.season)
          .eq("week", league.current_week)
          .maybeSingle()
          .then((r) => nextOpponents.set(id, r.data?.opponent ?? null)),
      ]),
  );

  // Season totals from this league-season's scored weeks -- the same
  // aggregates the Players tab shows (sum, average, last completed week).
  const scoresByPlayer = new Map<string, ScoreRow[]>();
  for (const row of (scoreRows ?? []) as ScoreRow[]) {
    const list = scoresByPlayer.get(row.player_id) ?? [];
    list.push(row);
    scoresByPlayer.set(row.player_id, list);
  }

  // Build in the order the ids were given; drop unknown/invalid ids.
  const players: ComparePlayer[] = ids
    .filter((id) => byId.has(id))
    .map((id) => {
      const p = byId.get(id)!;
      const weeks = scoresByPlayer.get(id) ?? [];
      const total = weeks.reduce((sum, w) => sum + Number(w.points), 0);
      const last = weeks.find((w) => w.week === lastWeek);
      return {
        id,
        name: p.full_name,
        position: p.position,
        teamAbbr: p.team_abbr,
        headshotUrl: p.headshot_url,
        nextOpponent: nextOpponents.get(id) ?? null,
        stats: {
          total: Math.round(total * 100) / 100,
          avg: weeks.length ? Math.round((total / weeks.length) * 100) / 100 : 0,
          last: last ? Number(last.points) : 0,
          projection: projections.get(id) ?? null,
        },
      };
    });

  const rows = buildCompareRows(players);

  const selected: PickerPlayer[] = players.map((p) => ({
    id: p.id,
    name: p.name,
    position: p.position,
    teamAbbr: p.teamAbbr,
  }));

  const results: PickerPlayer[] = (
    (poolMatches ?? []) as {
      player_id: string;
      full_name: string;
      pos: string | null;
      team_abbr: string | null;
    }[]
  ).map((r) => ({
    id: r.player_id,
    name: r.full_name,
    position: r.pos,
    teamAbbr: r.team_abbr,
  }));

  return (
    <div className="space-y-5">
      <header>
        <Link href={`/l/${leagueId}/players`} className="muted text-sm">
          &larr; All players
        </Link>
        <h1 className="h1 mt-1">Compare players</h1>
        <p className="muted">
          Pick two or three players to see their season average, total, last
          week and next-week projection side by side &mdash; for start/sit and
          trade calls. Scored with this league&rsquo;s rules.
        </p>
      </header>

      <ComparePicker selected={selected} results={results} />

      {players.length < 2 ? (
        <div className="card-tight border-dashed p-6 text-center">
          <p className="muted mx-auto max-w-sm">
            {players.length === 0
              ? "Search for a player above to start a comparison. Add two or three to line up their numbers side by side."
              : "One more to go — add at least one more player to compare side by side."}
          </p>
        </div>
      ) : null}

      {players.length >= 1 && (
        <>
          {/* Desktop: players as columns, a row per stat, each player's
              own column centred under his headshot. */}
          <div className="card-tight hidden overflow-hidden md:block">
            <table className="table">
              <thead>
                <tr>
                  <td className="w-px" />
                  {players.map((p) => (
                    <th
                      key={p.id}
                      scope="col"
                      className="px-3 pt-4 pb-3 text-center align-bottom normal-case"
                    >
                      <Link
                        href={`/l/${leagueId}/players/${p.id}`}
                        className="group mx-auto flex max-w-[13rem] flex-col items-center gap-1.5"
                      >
                        <Headshot url={p.headshotUrl} name={p.name} size={48} />
                        <span className="block w-full truncate text-sm font-semibold text-foreground group-hover:text-accent">
                          {p.name}
                        </span>
                        <span className="text-xs font-normal tracking-normal text-muted">
                          {positionLabel(p.position)}
                          {p.teamAbbr ? ` · ${p.teamAbbr}` : ""}
                        </span>
                        <NextOpp opponent={p.nextOpponent} />
                      </Link>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td className="whitespace-nowrap text-sm font-medium text-muted">
                      {row.label}
                    </td>
                    {row.values.map((value, i) => (
                      <td key={players[i].id} className="text-center">
                        <span
                          className={`score text-xl ${
                            row.bestIndex === i ? "stat-lead px-2.5 py-1" : ""
                          }`}
                        >
                          {value === null ? "—" : Number(value).toFixed(1)}
                          {row.bestIndex === i && (
                            <span className="sr-only"> (leads)</span>
                          )}
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: the same side-by-side grid, compact. It scrolls inside
              its own card (never the page) when three players make it wider
              than the screen, and the metric column stays pinned on the left
              so every number keeps its label. */}
          <div className="card-tight overflow-x-auto md:hidden">
            <table className="table">
              <thead>
                <tr>
                  <td className="sticky left-0 z-10 w-px bg-surface" />
                  {players.map((p) => (
                    <th
                      key={p.id}
                      scope="col"
                      className="min-w-[5.25rem] px-2 pt-3 pb-2.5 text-center normal-case"
                    >
                      <Link
                        href={`/l/${leagueId}/players/${p.id}`}
                        className="group mx-auto flex flex-col items-center gap-1"
                      >
                        <Headshot url={p.headshotUrl} name={p.name} size={32} />
                        <span className="block w-full truncate text-xs font-semibold text-foreground group-hover:text-accent">
                          {p.name}
                        </span>
                        <span className="block w-full truncate text-[10px] font-normal tracking-normal text-muted">
                          {positionLabel(p.position)}
                          {p.teamAbbr ? ` · ${p.teamAbbr}` : ""}
                        </span>
                        <NextOpp opponent={p.nextOpponent} />
                      </Link>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td className="sticky left-0 z-10 bg-surface whitespace-nowrap text-xs font-medium text-muted">
                      {row.label}
                    </td>
                    {row.values.map((value, i) => (
                      <td key={players[i].id} className="text-center">
                        <span
                          className={`score text-base ${
                            row.bestIndex === i ? "stat-lead px-2 py-0.5" : ""
                          }`}
                        >
                          {value === null ? "—" : Number(value).toFixed(1)}
                          {row.bestIndex === i && (
                            <span className="sr-only"> (leads)</span>
                          )}
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Next week's fixture as a small chip under a player's name: his opponent,
 * or a BYE in the negative colour -- the one thing you most want to catch
 * before you trust his projection in a start/sit call.
 */
function NextOpp({ opponent }: { opponent: string | null }) {
  if (!opponent) {
    return (
      <span className="inline-flex items-center rounded-full border border-negative/40 bg-negative/10 px-2 py-0.5 text-[11px] font-semibold tracking-normal text-negative">
        BYE
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] font-medium tracking-normal text-muted">
      vs {opponent}
    </span>
  );
}
