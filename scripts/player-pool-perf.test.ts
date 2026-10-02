/**
 * T-062 guard: the Players tab's pool query must stay fast and must
 * paginate in SQL.
 *
 *   npm test
 *
 * league_player_pool builds several per-player aggregates (season totals,
 * projection, last week, bye, next game). Before 0043 those were inlined
 * CTEs that the planner re-ran once per outer player row, so a realistic
 * ~2,700-player pool took ~300 SECONDS per page load. 0043 marks them
 * `materialized` (evaluated once, then joined by key).
 *
 * These tests seed a large pool and pin the two properties that must not
 * regress:
 *   1. the RPC returns at most p_limit rows and the right total_count,
 *      and consecutive pages are disjoint -- i.e. it paginates in SQL,
 *      not by fetching the whole pool and slicing in JS;
 *   2. it finishes well inside a budget that the per-row re-execution
 *      bug blows straight past.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, type TestDb } from "./lib/test-db.ts";
import { SEASON, buildLeague } from "./lib/fixtures.ts";

let db: TestDb;
let leagueId: string;

// Big enough that the old per-row re-execution is catastrophic, small
// enough that the fixed query (and seeding) stays quick.
const POOL = 900;
const WEEKS = 17;
const CURRENT_WEEK = 10;
const PAGE_SIZE = 50;

before(async () => {
  db = await createTestDb();
  const f = await buildLeague(db, "pool-perf");
  leagueId = f.leagueId;

  const teams = (
    await db.q<{ abbr: string }>("select abbr from public.nfl_teams order by abbr")
  ).map((r) => r.abbr);

  // A projection stat line made of keys this league actually scores, so
  // the projection CTE does real work (its lateral rule lookup is the
  // part that used to be re-run per row).
  const ruleKeys = (
    await db.q<{ stat_key: string }>(
      "select distinct stat_key from public.league_scoring_rules where league_id = $1",
      [leagueId],
    )
  ).map((r) => r.stat_key);
  const projStats: Record<string, number> = {};
  for (let k = 0; k < Math.min(20, ruleKeys.length); k++) {
    projStats[ruleKeys[k]] = (k + 1) * 1.5;
  }

  // Set-based seeding so this stays fast.
  await db.q(
    `insert into public.nfl_players (id, full_name, position, team_abbr, status)
     select 'PP' || g, 'Pool Player ' || g,
            (array['QB','RB','WR','TE','K'])[(g % 5) + 1],
            (select abbr from public.nfl_teams order by abbr offset (g % $1) limit 1),
            'ACT'
     from generate_series(0, $2 - 1) g
     on conflict (id) do nothing`,
    [teams.length, POOL],
  );
  await db.q(
    `insert into public.player_season_projections (player_id, season, stats)
     select 'PP' || g, $1, $2::jsonb from generate_series(0, $3 - 1) g
     on conflict (player_id, season) do nothing`,
    [SEASON, JSON.stringify(projStats), POOL],
  );
  await db.q(
    `insert into public.player_week_scores (league_id, player_id, season, week, points)
     select $1, 'PP' || g, $2, w, ((g + w) % 31)::numeric
     from generate_series(0, $3 - 1) g, generate_series(1, $4) w
     on conflict (league_id, player_id, season, week) do nothing`,
    [leagueId, SEASON, POOL, WEEKS],
  );

  // A schedule so bye / next_game have rows to chew on.
  for (let w = 1; w <= WEEKS; w++) {
    for (let ti = 0; ti + 1 < teams.length; ti += 2) {
      const id = `${SEASON}_${String(w).padStart(2, "0")}_${teams[ti]}_${teams[ti + 1]}`;
      await db.q(
        `insert into public.nfl_games
           (id, season, week, season_type, home_team, away_team, kickoff_at, status)
         values ($1, $2, $3, 'REG', $4, $5, now() + ($6 || ' days')::interval, 'scheduled')
         on conflict (id) do nothing`,
        [id, SEASON, w, teams[ti], teams[ti + 1], String(w)],
      );
    }
  }

  await db.exec(
    `update public.leagues set season = ${SEASON}, current_week = ${CURRENT_WEEK}
     where id = '${leagueId}'`,
  );
  await db.exec("analyze");
});

after(async () => {
  await db.close();
});

/** Positional args match the RPC signature. */
function call(
  sort = "points",
  limit = PAGE_SIZE,
  offset = 0,
  availability = "all",
  dir = "desc",
) {
  return db.q<{ player_id: string; total_count: string }>(
    `select player_id, total_count
     from public.league_player_pool($1, null, null, $2, $3, $4, $5, null, $6)`,
    [leagueId, availability, sort, limit, offset, dir],
  );
}

describe("league_player_pool pagination (T-062)", () => {
  test("returns at most one page and the full total_count", async () => {
    const rows = await call();
    assert.equal(rows.length, PAGE_SIZE, "a page is exactly p_limit rows");
    // total_count is the whole pool, not just the page -- the window
    // count runs over the filtered set in SQL.
    assert.ok(
      Number(rows[0].total_count) >= POOL,
      `total_count (${rows[0].total_count}) should cover the whole seeded pool`,
    );
  });

  test("consecutive pages are disjoint (paginated in SQL, not sliced in JS)", async () => {
    const p1 = await call("points", PAGE_SIZE, 0);
    const p2 = await call("points", PAGE_SIZE, PAGE_SIZE);
    const ids1 = new Set(p1.map((r) => r.player_id));
    const overlap = p2.filter((r) => ids1.has(r.player_id));
    assert.equal(overlap.length, 0, "page 2 must not repeat page 1");
    assert.equal(p2.length, PAGE_SIZE);
  });
});

describe("league_player_pool performance (T-062)", () => {
  // The fixed query runs in well under a second on this fixture; the
  // per-row re-execution bug took tens of seconds at this size. 10s is a
  // wide margin that still fails hard if the materialization is lost.
  const BUDGET_MS = 10_000;

  test("default page load stays within budget", async () => {
    await call(); // warm
    const start = performance.now();
    await call();
    const elapsed = performance.now() - start;
    assert.ok(
      elapsed < BUDGET_MS,
      `default pool page took ${elapsed.toFixed(0)}ms, budget ${BUDGET_MS}ms ` +
        `(a per-row re-execution regression would blow past this)`,
    );
  });

  test("projection sort also stays within budget", async () => {
    const start = performance.now();
    await call("projection");
    const elapsed = performance.now() - start;
    assert.ok(
      elapsed < BUDGET_MS,
      `projection sort took ${elapsed.toFixed(0)}ms, budget ${BUDGET_MS}ms`,
    );
  });
});
