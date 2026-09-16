/**
 * Edge cases for finding multi-week matchups (T-009, tester).
 *
 *   npm test
 *
 * Unlike matchup-weeks.test.ts, the database half here calls the real
 * `fetchMatchupsCoveringWeek` through a small stand-in for the Supabase
 * query builder that turns its filters into SQL against the migrated
 * test database, so the `.or()` team filter and the start-week window
 * are exercised exactly as the pages build them.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, type TestDb } from "./lib/test-db.ts";
import {
  SEASON,
  buildLeague,
  makePlayer,
  type Fixture,
} from "./lib/fixtures.ts";
import {
  MAX_MATCHUP_WEEKS,
  candidateStartWeeks,
  fetchMatchupsCoveringWeek,
  matchupWeekOfLabel,
  matchupWinner,
  parseMatchupView,
} from "../src/lib/matchup-weeks.ts";

/* ------------------------------------------------------------------ */
/* A PostgREST-shaped client over the test database                    */
/* ------------------------------------------------------------------ */

function fakeSupabase(db: TestDb, calls: string[] = []) {
  return {
    from(table: string) {
      const where: string[] = [];
      const params: unknown[] = [];
      const p = (v: unknown) => {
        params.push(v);
        return `$${params.length}`;
      };
      const builder = {
        select() {
          return builder;
        },
        eq(col: string, v: unknown) {
          where.push(`${col} = ${p(v)}`);
          return builder;
        },
        gte(col: string, v: unknown) {
          where.push(`${col} >= ${p(v)}`);
          return builder;
        },
        lte(col: string, v: unknown) {
          where.push(`${col} <= ${p(v)}`);
          return builder;
        },
        or(filter: string) {
          const parts = filter.split(",").map((part) => {
            const [col, op, ...rest] = part.split(".");
            assert.equal(op, "eq", `unsupported or() operator in ${filter}`);
            return `${col} = ${p(rest.join("."))}`;
          });
          where.push(`(${parts.join(" or ")})`);
          return builder;
        },
        then<R>(
          resolve: (v: { data: unknown[] | null; error: unknown }) => R,
          reject?: (e: unknown) => R,
        ) {
          const sql = `select * from public.${table}${
            where.length ? ` where ${where.join(" and ")}` : ""
          }`;
          calls.push(sql);
          return db
            .q(sql, params)
            .then((rows) => resolve({ data: rows, error: null }))
            .catch((error) =>
              // PostgREST resolves with an error rather than throwing.
              resolve({ data: null, error }),
            )
            .catch(reject);
        },
      };
      return builder;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Pure edge cases                                                     */
/* ------------------------------------------------------------------ */

describe("matchup-weeks edges (pure)", () => {
  const twoWeek = { week: 15, week_count: 2 };

  test("?week= parsing: 15.0 is week 15; -1, 0, blank and 15.5 are the total", () => {
    assert.equal(parseMatchupView(twoWeek, "15.0"), 15);
    assert.equal(parseMatchupView(twoWeek, "-1"), "total");
    assert.equal(parseMatchupView(twoWeek, "0"), "total");
    assert.equal(parseMatchupView(twoWeek, ""), "total");
    assert.equal(parseMatchupView(twoWeek, "15.5"), "total");
    assert.equal(parseMatchupView(twoWeek, "17"), "total");
    assert.equal(parseMatchupView(twoWeek, "abc"), "total");
    assert.equal(parseMatchupView(twoWeek, []), "total");
  });

  test("a week_count of null (legacy row) behaves as a single week", () => {
    const legacy = { week: 3, week_count: null as unknown as number };
    assert.equal(parseMatchupView(legacy, "3"), "total");
    assert.equal(matchupWeekOfLabel(legacy, 3), null);
  });

  test("week 1 lookup: the window starts below 1 without breaking", () => {
    assert.deepEqual(candidateStartWeeks(1), { from: -2, to: 1 });
  });

  test("the window is exactly as wide as the longest allowed span", () => {
    const { from, to } = candidateStartWeeks(18);
    assert.equal(to - from + 1, MAX_MATCHUP_WEEKS);
  });

  test("a tie before the matchup is final has no winner, even at 0-0", () => {
    for (const status of ["scheduled", "in_progress"] as const) {
      assert.equal(
        matchupWinner({ status, home_score: 0, away_score: 0, away_team_id: "x" }),
        null,
      );
    }
  });

  test("numeric scores arriving as strings still compare as numbers", () => {
    // PostgREST returns numeric columns as strings in some setups.
    const m = {
      status: "final" as const,
      home_score: "9.5" as unknown as number,
      away_score: "10.25" as unknown as number,
      away_team_id: "x",
    };
    assert.equal(matchupWinner(m), "away");
    assert.equal(
      matchupWinner({ ...m, home_score: "100.0" as unknown as number, away_score: "100" as unknown as number }),
      null,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Database edge cases through the real fetch                          */
/* ------------------------------------------------------------------ */

describe("fetchMatchupsCoveringWeek (database)", () => {
  let db: TestDb;
  let a: Fixture;
  let b: Fixture;
  const ids: Record<string, string> = {};

  async function insert(
    f: Fixture,
    week: number,
    weekCount: number,
    home: string,
    away: string | null,
    opts: { bracket?: "winners" | "losers"; playoff?: boolean; season?: number } = {},
  ) {
    return (
      await db.one<{ id: string }>(
        `insert into public.matchups
           (league_id, season, week, week_count, bracket, home_team_id,
            away_team_id, is_playoff)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [
          f.leagueId,
          opts.season ?? SEASON,
          week,
          weekCount,
          opts.bracket ?? "winners",
          home,
          away,
          opts.playoff ?? weekCount > 1,
        ],
      )
    ).id;
  }

  async function fetchIds(
    f: Fixture,
    week: number,
    teamId?: string,
  ): Promise<string[]> {
    const rows = await fetchMatchupsCoveringWeek(fakeSupabase(db) as never, {
      leagueId: f.leagueId,
      season: SEASON,
      week,
      teamId,
    });
    return rows.map((m) => m.id).sort();
  }

  before(async () => {
    db = await createTestDb();
    a = await buildLeague(db, "mw-edge-a");
    b = await buildLeague(db, "mw-edge-b");
    const [a0, a1, a2, a3] = a.teamIds;
    const [b0, b1, b2, b3] = b.teamIds;

    // League A
    ids.aWeek1 = await insert(a, 1, 1, a0, a1);
    ids.aWeek1b = await insert(a, 1, 1, a2, a3);
    // 4-week final, weeks 15-18.
    ids.aFour = await insert(a, 15, 4, a0, a1);
    // Last season's matchup in the same weeks must not leak in.
    ids.aOldSeason = await insert(a, 15, 2, a2, a3, { season: SEASON - 1 });

    // League B: overlapping spans with league A.
    // 2-week semi at 15-16 with a bye in the same round, and a 1-week
    // consolation game in week 16 (mixed week).
    ids.bSemi = await insert(b, 15, 2, b0, b1);
    ids.bBye = await insert(b, 15, 2, b2, null);
    ids.bConsolation = await insert(b, 16, 1, b3, b2, {
      bracket: "losers",
      playoff: true,
    });
    // A 3-week round starting at 16 overlaps both.
    ids.bThree = await insert(b, 17, 3, b0, b2);
  });

  after(async () => {
    await db.close();
  });

  test("the DB rejects a span longer than the lookup window", async () => {
    await assert.rejects(
      insert(a, 10, MAX_MATCHUP_WEEKS + 1, a.teamIds[0], a.teamIds[1]),
    );
  });

  test("4-week matchup at 15-18: found from 15, 16, 17 and 18, not 14 or 19", async () => {
    for (const w of [15, 16, 17, 18]) {
      assert.deepEqual(await fetchIds(a, w), [ids.aFour], `week ${w}`);
      assert.deepEqual(
        await fetchIds(a, w, a.teamIds[1]),
        [ids.aFour],
        `away team week ${w}`,
      );
    }
    assert.deepEqual(await fetchIds(a, 14), []);
    assert.deepEqual(await fetchIds(a, 19), []);
  });

  test("regular-season week 1 finds both week-1 games when W-3 < 1", async () => {
    assert.deepEqual(await fetchIds(a, 1), [ids.aWeek1, ids.aWeek1b].sort());
    assert.deepEqual(await fetchIds(a, 1, a.teamIds[3]), [ids.aWeek1b]);
  });

  test("two leagues with overlapping spans never see each other's games", async () => {
    const aIds = new Set(Object.entries(ids).filter(([k]) => k.startsWith("a")).map(([, v]) => v));
    const bIds = new Set(Object.entries(ids).filter(([k]) => k.startsWith("b")).map(([, v]) => v));
    for (let w = 1; w <= 20; w++) {
      for (const id of await fetchIds(a, w)) assert.ok(aIds.has(id), `A week ${w}`);
      for (const id of await fetchIds(b, w)) assert.ok(bIds.has(id), `B week ${w}`);
    }
    // Team filter with a team from the other league finds nothing.
    assert.deepEqual(await fetchIds(a, 16, b.teamIds[0]), []);
  });

  test("a previous season in the same weeks is not returned", async () => {
    assert.ok(!(await fetchIds(a, 15)).includes(ids.aOldSeason));
    assert.ok(!(await fetchIds(a, 16, a.teamIds[2])).includes(ids.aOldSeason));
  });

  test("a bye inside a 2-week round is found in week 2 for the bye team", async () => {
    assert.deepEqual(await fetchIds(b, 16, b.teamIds[2]).then((r) => r.filter((id) => id === ids.bBye)), [ids.bBye]);
    // Week 15: bye team has only the bye.
    assert.deepEqual(await fetchIds(b, 15, b.teamIds[2]), [ids.bBye]);
  });

  test("mixed week: a 1-week consolation game and a 2-week semi both appear exactly once", async () => {
    const week16 = await fetchIds(b, 16);
    assert.deepEqual(
      week16,
      [ids.bSemi, ids.bBye, ids.bConsolation].sort(),
    );
    assert.equal(new Set(week16).size, week16.length, "no duplicates");
    assert.deepEqual(await fetchIds(b, 16, b.teamIds[3]), [ids.bConsolation]);
    assert.deepEqual(await fetchIds(b, 16, b.teamIds[0]), [ids.bSemi]);
  });

  test("the next round takes over cleanly the week after a span ends", async () => {
    assert.deepEqual(await fetchIds(b, 17), [ids.bThree]);
    assert.deepEqual(await fetchIds(b, 19), [ids.bThree]);
    assert.deepEqual(await fetchIds(b, 20), []);
  });

  test("the query window is W-3..W and the season/league are always filtered", async () => {
    const calls: string[] = [];
    await fetchMatchupsCoveringWeek(fakeSupabase(db, calls) as never, {
      leagueId: a.leagueId,
      season: SEASON,
      week: 18,
      teamId: a.teamIds[0],
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0], /league_id = \$1/);
    assert.match(calls[0], /season = \$2/);
    assert.match(calls[0], /week >= \$3/);
    assert.match(calls[0], /week <= \$4/);
  });

  test("a failed query yields no matchups rather than throwing", async () => {
    const broken = {
      from: () => {
        const b: Record<string, unknown> = {};
        for (const k of ["select", "eq", "gte", "lte", "or"]) b[k] = () => b;
        b.then = (resolve: (v: unknown) => unknown) =>
          resolve({ data: null, error: { message: "boom" } });
        return b;
      },
    };
    assert.deepEqual(
      await fetchMatchupsCoveringWeek(broken as never, {
        leagueId: a.leagueId,
        season: SEASON,
        week: 16,
      }),
      [],
    );
  });
});

/* ------------------------------------------------------------------ */
/* Per-week points add up to the stored total                          */
/* ------------------------------------------------------------------ */

describe("team_points_over per week vs the matchup total", () => {
  let db: TestDb;

  before(async () => {
    db = await createTestDb();
  });

  after(async () => {
    await db.close();
  });

  test("a 2-week matchup's week 1 + week 2 equals its recomputed score; a bye scores too", async () => {
    const f = await buildLeague(db, "mw-edge-points");
    const [h, aw, byeTeam] = f.teamIds;

    const m = await db.one<{ id: string }>(
      `insert into public.matchups
         (league_id, season, week, week_count, home_team_id, away_team_id, is_playoff)
       values ($1, $2, 13, 2, $3, $4, true) returning id`,
      [f.leagueId, SEASON, h, aw],
    );
    const bye = await db.one<{ id: string }>(
      `insert into public.matchups
         (league_id, season, week, week_count, home_team_id, away_team_id, is_playoff)
       values ($1, $2, 13, 2, $3, null, true) returning id`,
      [f.leagueId, SEASON, byeTeam],
    );

    const wr = await makePlayer(db, "MW_EDGE_WR", "Edge WR", "WR");
    const wr2 = await makePlayer(db, "MW_EDGE_WR2", "Edge WR2", "WR");
    const wr3 = await makePlayer(db, "MW_EDGE_WR3", "Edge WR3", "WR");
    const yards: [string, string, number, number][] = [
      [wr, h, 13, 100],
      [wr, h, 14, 40],
      [wr2, aw, 13, 70],
      [wr2, aw, 14, 70],
      [wr3, byeTeam, 14, 55],
    ];
    for (const [pid, team, week, y] of yards) {
      const gid = `${SEASON}_${week}_MWEDGE_${pid}`;
      await db.q(
        `insert into public.nfl_games (id, season, week, home_team, away_team, status)
         values ($1, $2, $3, 'KC', 'BUF', 'final') on conflict (id) do nothing`,
        [gid, SEASON, week],
      );
      await db.q(
        `insert into public.player_game_stats (player_id, game_id, season, week, stats, source)
         values ($1, $2, $3, $4, $5, 'final')`,
        [pid, gid, SEASON, week, JSON.stringify({ receiving_yards: y })],
      );
      await db.q(
        `insert into public.lineup_entries (league_id, team_id, season, week, player_id, slot_key)
         values ($1, $2, $3, $4, $5, 'WR')`,
        [f.leagueId, team, SEASON, week, pid],
      );
    }

    for (const week of [13, 14]) {
      await db.q("select public.recompute_week_scores($1, $2, $3)", [
        f.leagueId,
        SEASON,
        week,
      ]);
    }

    const perWeek = async (week: number) =>
      new Map(
        (
          await db.q<{ team_id: string; points: string }>(
            "select * from public.team_points_over($1, $2, $3, $3)",
            [f.leagueId, SEASON, week],
          )
        ).map((r) => [r.team_id, Number(r.points)]),
      );
    const w13 = await perWeek(13);
    const w14 = await perWeek(14);

    const stored = await db.one<{ home_score: string; away_score: string }>(
      "select home_score, away_score from public.matchups where id = $1",
      [m.id],
    );
    assert.ok(Number(stored.home_score) > 0, "scoring produced points");
    assert.equal(
      (w13.get(h) ?? 0) + (w14.get(h) ?? 0),
      Number(stored.home_score),
    );
    assert.equal(
      (w13.get(aw) ?? 0) + (w14.get(aw) ?? 0),
      Number(stored.away_score),
    );

    // The bye team started nobody in week 13: the page defaults that to 0.
    assert.equal(w13.get(byeTeam), undefined);
    const byeRow = await db.one<{ home_score: string }>(
      "select home_score from public.matchups where id = $1",
      [bye.id],
    );
    assert.equal((w13.get(byeTeam) ?? 0) + (w14.get(byeTeam) ?? 0), Number(byeRow.home_score));
  });
});
