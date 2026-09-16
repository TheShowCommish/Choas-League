import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLeagueContext } from "@/lib/league";
import { createClient } from "@/lib/supabase/server";
import { describeInjury, INJURY_CLASS, type InjurySummary } from "@/lib/injury";
import {
  fetchPlayerResearch,
  type NewsItem,
  type PlayerBlurb,
} from "@/lib/research/news";
import { STAT_BY_KEY } from "@/lib/stats/catalog";
import type { NflPlayer, ScoreBreakdownEntry } from "@/lib/types";
import { positionLabel } from "@/lib/roster-slots";

interface WeekRow {
  week: number;
  points: number;
  is_final: boolean;
  breakdown: Record<string, ScoreBreakdownEntry>;
}

interface RawStatRow {
  week: number;
  stats: Record<string, number>;
  source: string;
}

/** One stat, and where this player sits at his position in it. */
interface StatRank {
  stat_key: string;
  total: number;
  rank: number;
  /** How many players at the position recorded the stat at all. */
  pool: number;
}

export default async function PlayerPage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string; playerId: string }>;
  searchParams: Promise<{ season?: string }>;
}) {
  const { leagueId, playerId } = await params;
  const { season: seasonParam } = await searchParams;
  const { league } = await getLeagueContext(leagueId);
  const supabase = await createClient();

  // Every season we hold a stat line for, newest first. Scored points
  // only exist for the league's own season -- the scoring engine writes
  // player_week_scores per league-season -- so other years show the raw
  // stat line and say so.
  const { data: seasonRows } = await supabase
    .from("player_game_stats")
    .select("season")
    .eq("player_id", playerId)
    .order("season", { ascending: false });

  const seasons = [
    ...new Set((seasonRows ?? []).map((r) => r.season as number)),
  ].sort((a, b) => b - a);

  const requested = Number(seasonParam);
  const season =
    seasons.includes(requested) ? requested
    : seasons.includes(league.season) ? league.season
    : (seasons[0] ?? league.season);

  const isLeagueSeason = season === league.season;

  const [
    { data: player, error: playerError },
    { data: scores },
    { data: raw },
    { data: owner },
  ] = await Promise.all([
      supabase.from("nfl_players").select("*").eq("id", playerId).maybeSingle(),
      supabase
        .from("player_week_scores")
        .select("week, points, is_final, breakdown")
        .eq("league_id", leagueId)
        .eq("player_id", playerId)
        .eq("season", season)
        .order("week"),
      supabase
        .from("player_game_stats")
        .select("week, stats, source")
        .eq("player_id", playerId)
        .eq("season", season)
        .order("week"),
      supabase
        .from("roster_players")
        .select("team_id, teams(name)")
        .eq("league_id", leagueId)
        .eq("player_id", playerId)
        .is("dropped_at", null)
        .maybeSingle(),
    ]);

  // A failed query and a player who does not exist are different things.
  // Collapsing both into a 404 hides real faults -- an RLS change or a
  // malformed select looks exactly like a bad URL.
  // Both of these are best-effort: an unofficial third-party API is not
  // allowed to decide whether this page renders.
  const [projectedPoints, projection, seasonProjection, statRanks] =
    await Promise.all([
    isLeagueSeason
      ? supabase
          .rpc("projected_points", {
            p_league: leagueId,
            p_player: playerId,
            p_season: season,
            p_week: league.current_week,
          })
          .then((r) => (r.error ? null : (r.data as number | null)))
      : Promise.resolve(null),
    supabase
      .from("player_week_projections")
      .select("stats, opponent, injury_status")
      .eq("player_id", playerId)
      .eq("season", season)
      .eq("week", league.current_week)
      .maybeSingle()
      .then((r) => r.data),
    isLeagueSeason
      ? supabase
          .rpc("league_season_projection", {
            p_league: leagueId,
            p_season: season,
          })
          .then((r) =>
            r.error
              ? null
              : ((r.data as { player_id: string; points: number }[]).find(
                  (row) => row.player_id === playerId,
                )?.points ?? null),
          )
      : Promise.resolve(null),
    // Where he sits at his own position in each stat. Best-effort like
    // the rest: a stat table without ranks is still a stat table.
    supabase
      .rpc("player_stat_ranks", { p_player: playerId, p_season: season })
      .then((r) => (r.error ? [] : (r.data as StatRank[]))),
  ]);

  if (playerError) {
    throw new Error(`Could not load player ${playerId}: ${playerError.message}`);
  }
  if (!player) notFound();

  const p = player as NflPlayer;
  const { news, blurb } = await fetchPlayerResearch(p.espn_id);
  const weeks = (scores ?? []) as WeekRow[];
  const rawByWeek = new Map(
    ((raw ?? []) as RawStatRow[]).map((r) => [r.week, r.stats]),
  );

  /*
   * What is wrong with him.
   *
   * The injury job is the first choice: it carries the body part and the
   * practice report, which is what turns a designation into a decision.
   * The weekly projection's status is the fallback for a player the job
   * has not reached yet -- it is only a word, but a word is better than
   * a silent page next to a man who is on injured reserve.
   */
  const injury: InjurySummary | null =
    describeInjury(p) ??
    (projection?.injury_status
      ? describeInjury({ injury_status: projection.injury_status as string })
      : null);

  const total = weeks.reduce((sum, w) => sum + Number(w.points), 0);
  const ownerName = (owner?.teams as unknown as { name: string } | null)?.name;

  const rankByStat = new Map(
    (statRanks ?? []).map((r) => [r.stat_key, r] as const),
  );

  // Every stat this player has recorded all season, most productive first.
  const seasonTotals = new Map<string, number>();
  for (const stats of rawByWeek.values()) {
    for (const [key, value] of Object.entries(stats)) {
      if (typeof value !== "number") continue;
      seasonTotals.set(key, (seasonTotals.get(key) ?? 0) + value);
    }
  }

  return (
    <div className="space-y-5">
      <header>
        <Link href={`/l/${leagueId}/players`} className="muted text-sm">
          &larr; All players
        </Link>

        <div className="mt-1 flex items-center gap-4">
          {p.headshot_url && (
            <Image
              src={p.headshot_url}
              alt=""
              width={80}
              height={80}
              className="size-20 shrink-0 rounded-full border border-border bg-surface object-cover"
              // Decorative: the name is right beside it in the heading.
              aria-hidden
            />
          )}

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="h1">{p.full_name}</h1>
              {injury && (
                <span
                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-semibold ${
                    INJURY_CLASS[injury.tone]
                  }`}
                >
                  {injury.label}
                  {injury.bodyPart && (
                    <span className="font-normal">· {injury.bodyPart}</span>
                  )}
                </span>
              )}
            </div>
            <p className="muted">
              {positionLabel(p.position)} &middot; {p.team_abbr ?? "Free agent"}
              {p.jersey_number != null && <> &middot; #{p.jersey_number}</>}
              {ownerName ? (
                <> &middot; rostered by {ownerName}</>
              ) : (
                <> &middot; available</>
              )}
            </p>
          </div>
        </div>
      </header>

      {seasons.length > 1 && (
        <nav className="flex flex-wrap items-center gap-2">
          <span className="muted text-sm">Season</span>
          {seasons.map((year) => (
            <Link
              key={year}
              href={`/l/${leagueId}/players/${playerId}?season=${year}`}
              className={`btn btn-sm ${year === season ? "btn-primary" : ""}`}
            >
              {year}
            </Link>
          ))}
        </nav>
      )}

      {!isLeagueSeason && (
        <p className="card muted text-sm">
          {season} is not this league&rsquo;s season, so there are no fantasy
          points for it &mdash; scoring is applied per league-season. The raw
          stat lines below are the real thing.
        </p>
      )}

      {/*
        Stats across the top, news down the right, the full stat table at
        the bottom. The numbers are what the page is for, so they get the
        width; the news is a column you glance at, so it gets a column.
      */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-5">
          <div className="card flex flex-wrap gap-4">
            <Stat label="Season points" value={total.toFixed(1)} />
            <Stat label="Games" value={String(weeks.length)} />
            <Stat
              label="Average"
              value={weeks.length ? (total / weeks.length).toFixed(1) : "0.0"}
            />
            <Stat
              label="Best week"
              value={
                weeks.length
                  ? Math.max(...weeks.map((w) => Number(w.points))).toFixed(1)
                  : "0.0"
              }
            />
            {seasonProjection !== null && (
              <Stat
                label={`${season} projected`}
                value={Number(seasonProjection).toFixed(0)}
              />
            )}
          </div>

          {(projection || projectedPoints !== null) && (
            <section className="card space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="h2">Week {league.current_week} projection</h2>
                {projectedPoints !== null && (
                  <span className="text-lg font-semibold tabular-nums">
                    {Number(projectedPoints).toFixed(1)} pts
                  </span>
                )}
              </div>

              <p className="muted text-sm">
                Sleeper&rsquo;s projected stat line, scored with this
                league&rsquo;s rules rather than theirs
                {projection?.opponent ? ` · vs ${projection.opponent}` : ""}.
              </p>

              {projection?.stats && (
                <p className="muted text-xs">
                  {Object.entries(projection.stats as Record<string, number>)
                    .sort((a, b) => b[1] - a[1])
                    .map(
                      ([key, value]) =>
                        `${STAT_BY_KEY[key]?.label ?? key} ${round(value)}`,
                    )
                    .join(" · ")}
                </p>
              )}
            </section>
          )}

          <section>
            <h2 className="h2 mb-2">Week by week</h2>
            {weeks.length === 0 ? (
              <p className="card muted">
                {isLeagueSeason
                  ? "No scored games yet this season."
                  : `No scored games for ${season}.`}
              </p>
            ) : (
              <div className="space-y-2">
                {weeks.map((w) => (
                  <WeekCard
                    key={w.week}
                    week={w}
                    rawStats={rawByWeek.get(w.week) ?? {}}
                  />
                ))}
              </div>
            )}
          </section>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          {injury && <InjuryCard injury={injury} blurb={blurb} />}

          <section>
            <h2 className="h2 mb-2">{p.full_name.split(" ").pop()} news</h2>
            {news.length === 0 ? (
              <p className="card muted text-sm">
                Nothing filed about him lately.
              </p>
            ) : (
              <NewsList news={news} />
            )}
          </section>
        </aside>
      </div>

      {seasonTotals.size > 0 && (
        <section>
          <h2 className="h2 mb-2">{season} stat totals</h2>
          <p className="muted mb-2 text-sm">
            Everything recorded for this player, whether or not your league
            scores it. The rank is against everyone at{" "}
            {positionLabel(p.position)} who recorded the same stat.
          </p>
          <div className="card-tight table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Stat</th>
                  <th className="text-right">Total</th>
                  <th className="text-right">
                    {positionLabel(p.position)} rank
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...seasonTotals.entries()]
                  .filter(([, value]) => value !== 0)
                  .sort((a, b) => a[0].localeCompare(b[0]))
                  .map(([key, value]) => (
                    <tr key={key}>
                      <td>
                        {STAT_BY_KEY[key]?.label ?? key}
                        <span className="muted ml-2 text-xs">
                          {STAT_BY_KEY[key]?.category}
                        </span>
                      </td>
                      <td className="text-right tabular-nums">
                        {round(value)}
                      </td>
                      <td className="text-right">
                        <PositionRank rank={rankByStat.get(key)} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * The injury, spelled out.
 *
 * A designation on its own does not answer the question a manager
 * actually has, which is whether to go looking for a replacement. So
 * this says three things in order: what the designation means for
 * availability, what is hurt and how the week's practice has gone, and
 * -- when there is one -- the beat writer's line on the timeline, which
 * is the only place "back for week one" ever comes from.
 */
function InjuryCard({
  injury,
  blurb,
}: {
  injury: InjurySummary;
  blurb: PlayerBlurb | null;
}) {
  return (
    <section
      // The tone classes carry their own border and tint; card-tight's
      // own colours sit in the components layer and are overridden by
      // them, so adding a background here would only fight them.
      className={`card-tight p-3 ${INJURY_CLASS[injury.tone]}`}
    >
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold">
          {injury.label}
          {injury.bodyPart && ` · ${injury.bodyPart}`}
        </h2>
      </div>

      <p className="mt-1 text-sm text-foreground">{injury.outlook}</p>

      {injury.practice && (
        <p className="muted mt-1 text-xs">Practice: {injury.practice}</p>
      )}
      {injury.notes && (
        <p className="muted mt-1 text-xs">{injury.notes}</p>
      )}

      {blurb && (
        <div className="mt-3 border-t border-border/60 pt-2">
          <p className="text-xs font-medium text-foreground">
            {blurb.headline}
          </p>
          {blurb.story && (
            <p className="muted mt-1 text-xs">{blurb.story}</p>
          )}
        </div>
      )}
    </section>
  );
}

function NewsList({ news }: { news: NewsItem[] }) {
  return (
    <ul className="card-tight divide-y divide-border/60">
      {news.map((item) => (
        <li key={item.id} className="p-3">
          {item.url ? (
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium hover:text-accent"
            >
              {item.headline}
            </a>
          ) : (
            <p className="text-sm font-medium">{item.headline}</p>
          )}
          {item.description && (
            <p className="muted mt-1 text-xs">{item.description}</p>
          )}
          {item.published && (
            <time className="muted text-xs" dateTime={item.published}>
              {new Date(item.published).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </time>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * "4th of 38" -- and in bold when it is a number worth noticing.
 *
 * The top ten at a position is roughly the starter line in a twelve-team
 * league, which makes it the threshold that means something here.
 */
function PositionRank({ rank }: { rank?: StatRank }) {
  if (!rank) return <span className="muted text-xs">&mdash;</span>;

  return (
    <span
      className={`text-xs tabular-nums ${
        rank.rank <= 10 ? "font-semibold text-accent" : "text-muted"
      }`}
    >
      {ordinal(rank.rank)}
      <span className="muted font-normal"> of {rank.pool}</span>
    </span>
  );
}

/** 1st, 2nd, 3rd, 4th -- including the 11th-to-13th exceptions. */
function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="muted text-xs">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

/**
 * One week, expandable to show exactly which stats produced the score.
 * Being able to audit the maths matters when the league scores 40 stats.
 */
function WeekCard({
  week,
  rawStats,
}: {
  week: WeekRow;
  rawStats: Record<string, number>;
}) {
  const scoring = Object.entries(week.breakdown).sort(
    (a, b) => Math.abs(b[1].points) - Math.abs(a[1].points),
  );

  const unscored = Object.entries(rawStats).filter(
    ([key, value]) => value !== 0 && !(key in week.breakdown),
  );

  return (
    <details className="card-tight">
      <summary className="flex cursor-pointer items-center justify-between gap-3 p-3">
        <span className="text-sm font-medium">Week {week.week}</span>
        <span className="tabular-nums">
          {Number(week.points).toFixed(1)}
          {!week.is_final && <span className="muted text-xs"> (live)</span>}
        </span>
      </summary>

      <div className="border-t border-border px-3 py-2">
        {scoring.length === 0 ? (
          <p className="muted text-sm">Nothing scored this week.</p>
        ) : (
          <table className="table">
            <tbody>
              {scoring.map(([key, entry]) => (
                <tr key={key}>
                  <td>{STAT_BY_KEY[key]?.label ?? key}</td>
                  <td className="text-right tabular-nums">
                    {round(entry.value)}
                  </td>
                  <td
                    className={`text-right tabular-nums ${
                      entry.points < 0 ? "text-negative" : "text-positive"
                    }`}
                  >
                    {entry.points > 0 ? "+" : ""}
                    {Number(entry.points).toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {unscored.length > 0 && (
          <details className="mt-2">
            <summary className="muted cursor-pointer text-xs">
              {unscored.length} other stats recorded (worth 0 in this league)
            </summary>
            <p className="muted mt-1 text-xs">
              {unscored
                .map(
                  ([key, value]) =>
                    `${STAT_BY_KEY[key]?.label ?? key}: ${round(value)}`,
                )
                .join(" · ")}
            </p>
          </details>
        )}
      </div>
    </details>
  );
}

/** Stat values are a mix of integers and decimals; show only what is there. */
function round(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
