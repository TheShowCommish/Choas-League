/**
 * T-007 edge cases: a position override of 0 means zero.
 *
 *   npm test
 *
 * The happy paths live in league-logic.test.ts ("a position override of 0
 * means zero"). These pin the corners: multi-position rules, bonus flags,
 * negative base values, a score row that disappears while it is part of a
 * matchup, multi-week matchups, and the rescore at the end of 0039 leaving
 * final matchups alone.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestDb, MIGRATIONS_DIR, type TestDb } from "./lib/test-db.ts";
import { SEASON, buildLeague, giveStats, makePlayer } from "./lib/fixtures.ts";

let db: TestDb;

before(async () => {
  db = await createTestDb();
});

after(async () => {
  await db.close();
});

async function setRule(
  leagueId: string,
  statKey: string,
  points: number,
  positions: string[] = [],
) {
  await db.q(
    `insert into public.league_scoring_rules (league_id, stat_key, points, positions)
     values ($1, $2, $3, $4)
     on conflict (league_id, stat_key, positions)
     do update set points = excluded.points`,
    [leagueId, statKey, points, positions],
  );
}

async function removeRule(leagueId: string, statKey: string, positions: string[]) {
  await db.q(
    `delete from public.league_scoring_rules
     where league_id = $1 and stat_key = $2 and positions = $3`,
    [leagueId, statKey, positions],
  );
}

async function rescore(leagueId: string, week = 1) {
  // As that league's commissioner, who stays signed in for the member-only
  // reads (projections, the player pool) that follow.
  const { commissioner_id } = await db.one<{ commissioner_id: string }>(
    "select commissioner_id from public.leagues where id = $1",
    [leagueId],
  );
  await db.actAs(commissioner_id);
  await db.q("select public.recompute_week_scores($1, $2, $3)", [
    leagueId,
    SEASON,
    week,
  ]);
}

async function scoreRow(leagueId: string, playerId: string, week = 1) {
  const rows = await db.q<{ points: string; breakdown: Record<string, unknown> }>(
    `select points, breakdown from public.player_week_scores
     where league_id = $1 and player_id = $2 and season = $3 and week = $4`,
    [leagueId, playerId, SEASON, week],
  );
  return rows[0] ?? null;
}

async function actual(leagueId: string, playerId: string, week = 1) {
  const row = await scoreRow(leagueId, playerId, week);
  return row === null ? 0 : Number(row.points);
}

async function weekProjection(leagueId: string, playerId: string, line: Record<string, number>) {
  await db.q(
    `insert into public.player_week_projections (player_id, season, week, stats)
     values ($1, $2, 1, $3)
     on conflict (player_id, season, week) do update set stats = excluded.stats`,
    [playerId, SEASON, JSON.stringify(line)],
  );
  await db.q(
    `insert into public.player_season_projections (player_id, season, stats)
     values ($1, $2, $3)
     on conflict (player_id, season) do update set stats = excluded.stats`,
    [playerId, SEASON, JSON.stringify(line)],
  );
  const week = await db.one<{ points: string }>(
    "select public.projected_points($1, $2, $3, 1) as points",
    [leagueId, playerId, SEASON],
  );
  const season = await db.q<{ points: string }>(
    `select points from public.league_season_projection($1, $2) where player_id = $3`,
    [leagueId, SEASON, playerId],
  );
  return {
    week: Number(week.points),
    season: season.length === 0 ? 0 : Number(season[0].points),
  };
}

/** Put players in a team's starting lineup (or bench) for a week. */
async function lineup(
  leagueId: string,
  teamId: string,
  week: number,
  entries: [playerId: string, slot: string][],
) {
  for (const [playerId, slot] of entries) {
    await db.q(
      `insert into public.lineup_entries (league_id, team_id, season, week, player_id, slot_key)
       values ($1, $2, $3, $4, $5, $6)`,
      [leagueId, teamId, SEASON, week, playerId, slot],
    );
  }
}

async function matchupScore(leagueId: string, teamId: string, week: number) {
  const m = await db.one<{ id: string; home_team_id: string; home_score: string; away_score: string }>(
    `select id, home_team_id, home_score, away_score from public.matchups
     where league_id = $1 and season = $2 and week = $3
       and (home_team_id = $4 or away_team_id = $4)`,
    [leagueId, SEASON, week, teamId],
  );
  return {
    id: m.id,
    score: Number(m.home_team_id === teamId ? m.home_score : m.away_score),
  };
}

// ---------------------------------------------------------------------------

describe("T-007 zero override: rule resolution corners", () => {
  test("a multi-position rule of 0 ({WR,TE}) beats the base for both, not for others", async () => {
    const f = await buildLeague(db, "t007-multi");
    const wr = await makePlayer(db, "T7M_WR", "Multi WR", "WR");
    const te = await makePlayer(db, "T7M_TE", "Multi TE", "TE");
    const rb = await makePlayer(db, "T7M_RB", "Multi RB", "RB");
    for (const p of [wr, te, rb]) {
      await giveStats(db, p, 1, { tackles_combined: 2, receiving_yards: 10 });
    }

    await setRule(f.leagueId, "tackles_combined", 5);
    await setRule(f.leagueId, "tackles_combined", 0, ["WR", "TE"]);
    await rescore(f.leagueId);

    // receiving_yards default is 0.1/yd -> 1 point.
    assert.equal(await actual(f.leagueId, wr), 1);
    assert.equal(await actual(f.leagueId, te), 1);
    assert.equal(await actual(f.leagueId, rb), 11);

    const line = { tackles_combined: 2, receiving_yards: 10 };
    assert.deepEqual(await weekProjection(f.leagueId, wr, line), { week: 1, season: 1 });
    assert.deepEqual(await weekProjection(f.leagueId, rb, line), { week: 11, season: 11 });
  });

  test("a 0 override on a bonus flag drops the bonus only for that position", async () => {
    const f = await buildLeague(db, "t007-bonus");
    const qb = await makePlayer(db, "T7B_QB", "Bonus QB", "QB");
    const rb = await makePlayer(db, "T7B_RB", "Bonus RB", "RB");
    await giveStats(db, qb, 1, { rush_100_bonus: 1, rushing_yards: 100 });
    await giveStats(db, rb, 1, { rush_100_bonus: 1, rushing_yards: 100 });

    await setRule(f.leagueId, "rush_100_bonus", 3);
    await setRule(f.leagueId, "rush_100_bonus", 0, ["QB"]);
    await rescore(f.leagueId);

    const qbRow = await scoreRow(f.leagueId, qb);
    const rbRow = await scoreRow(f.leagueId, rb);
    assert.equal(Number(qbRow?.points), 10, "QB: 100 rush yards, no bonus");
    assert.ok(!("rush_100_bonus" in (qbRow?.breakdown ?? {})));
    assert.equal(Number(rbRow?.points), 13, "RB: 100 rush yards + 3 bonus");
  });

  test("a negative base with a 0 override: the override position loses nothing", async () => {
    const f = await buildLeague(db, "t007-negative");
    const wr = await makePlayer(db, "T7N_WR", "Neg WR", "WR");
    const rb = await makePlayer(db, "T7N_RB", "Neg RB", "RB");
    await giveStats(db, wr, 1, { rushing_fumbles_lost: 1 });
    await giveStats(db, rb, 1, { rushing_fumbles_lost: 1 });

    await setRule(f.leagueId, "rushing_fumbles_lost", -2);
    await setRule(f.leagueId, "rushing_fumbles_lost", 0, ["WR"]);
    await rescore(f.leagueId);

    assert.equal(await scoreRow(f.leagueId, wr), null, "WR's only stat scores nothing");
    assert.equal(await actual(f.leagueId, rb), -2, "negative totals are still written");

    const line = { rushing_fumbles_lost: 1 };
    assert.deepEqual(await weekProjection(f.leagueId, wr, line), { week: 0, season: 0 });
    assert.deepEqual(await weekProjection(f.leagueId, rb, line), { week: -2, season: -2 });
  });

  test("removing the 0 override restores the base value on the next rescore", async () => {
    const f = await buildLeague(db, "t007-remove");
    const wr = await makePlayer(db, "T7R_WR", "Remove WR", "WR");
    await giveStats(db, wr, 1, { tackles_combined: 1 });

    await setRule(f.leagueId, "tackles_combined", 5);
    await setRule(f.leagueId, "tackles_combined", 0, ["WR"]);
    await rescore(f.leagueId);
    assert.equal(await scoreRow(f.leagueId, wr), null);

    await removeRule(f.leagueId, "tackles_combined", ["WR"]);
    await rescore(f.leagueId);
    assert.equal(await actual(f.leagueId, wr), 5);
  });

  test("an explicit 0 override with no base row still scores nothing, and a live line is cleared too", async () => {
    const f = await buildLeague(db, "t007-live");
    const wr = await makePlayer(db, "T7L_WR", "Live WR", "WR");
    await giveStats(db, wr, 1, { receptions: 3 }, "live");

    await rescore(f.leagueId);
    assert.equal(await actual(f.leagueId, wr), 3);

    await setRule(f.leagueId, "receptions", 0, ["WR"]);
    await rescore(f.leagueId);
    assert.equal(await scoreRow(f.leagueId, wr), null);

    await removeRule(f.leagueId, "receptions", []);
    await rescore(f.leagueId);
    assert.equal(await scoreRow(f.leagueId, wr), null, "no rule at all still scores nothing");
  });
});

describe("T-007 zero override: a score row that disappears", () => {
  test("only this league's row is removed; another league keeps scoring the player", async () => {
    const a = await buildLeague(db, "t007-scope-a");
    const b = await buildLeague(db, "t007-scope-b");
    const wr = await makePlayer(db, "T7S_WR", "Scoped WR", "WR");
    await giveStats(db, wr, 1, { tackles_combined: 1 });

    for (const l of [a, b]) {
      await setRule(l.leagueId, "tackles_combined", 5);
      await rescore(l.leagueId);
    }
    await setRule(a.leagueId, "tackles_combined", 0, ["WR"]);
    await rescore(a.leagueId);

    assert.equal(await scoreRow(a.leagueId, wr), null);
    assert.equal(await actual(b.leagueId, wr), 5, "league B untouched");
  });

  test("an open matchup drops the starter's points; the player pool totals follow", async () => {
    const f = await buildLeague(db, "t007-matchup");
    await db.actAs(f.commish);
    await db.q("select public.generate_schedule($1)", [f.leagueId]);

    const wr = await makePlayer(db, "T7X_WR", "Tackling WR", "WR");
    const rb = await makePlayer(db, "T7X_RB", "Tackling RB", "RB");
    await giveStats(db, wr, 1, { tackles_combined: 1 });
    await giveStats(db, rb, 1, { tackles_combined: 1 });
    await giveStats(db, wr, 2, { tackles_combined: 2, receiving_yards: 30 });

    const team = f.teamIds[0];
    await db.q(
      `insert into public.roster_players (league_id, team_id, player_id)
       values ($1, $2, $3), ($1, $2, $4)`,
      [f.leagueId, team, wr, rb],
    );
    await lineup(f.leagueId, team, 1, [[wr, "WR"], [rb, "RB"]]);

    await setRule(f.leagueId, "tackles_combined", 5);
    await rescore(f.leagueId, 1);
    await rescore(f.leagueId, 2);
    assert.equal((await matchupScore(f.leagueId, team, 1)).score, 10);

    await setRule(f.leagueId, "tackles_combined", 0, ["WR"]);
    await db.q("select public.recompute_season_scores($1)", [f.leagueId]);

    assert.equal((await matchupScore(f.leagueId, team, 1)).score, 5, "RB's 5 only");

    const over = await db.one<{ points: string }>(
      `select points from public.team_points_over($1, $2, 1, 1) where team_id = $3`,
      [f.leagueId, SEASON, team],
    );
    assert.equal(Number(over.points), 5);

    // Pool: week 1 row gone, week 2 = 3 receiving points only.
    const pool = await db.one<{ total_points: string; avg_points: string; games: string }>(
      `select total_points, avg_points, games
       from public.league_player_pool($1, 'Tackling WR') where player_id = $2`,
      [f.leagueId, wr],
    );
    assert.equal(Number(pool.total_points), 3);
    assert.equal(Number(pool.games), 1, "a week that scores nothing is not a game");
    assert.equal(Number(pool.avg_points), 3);
  });

  test("a two-week matchup rescores across both weeks when an override of 0 lands", async () => {
    const f = await buildLeague(db, "t007-twoweek");
    await db.actAs(f.commish);
    await db.q("select public.generate_schedule($1)", [f.leagueId]);

    const team = f.teamIds[0];
    // Stretch this team's week-1 matchup over weeks 1-2 (the schedule
    // also has a week-2 row; drop it so the span is unambiguous).
    const { id } = await matchupScore(f.leagueId, team, 1);
    await db.q(
      `delete from public.matchups where league_id = $1 and week = 2
         and (home_team_id = $2 or away_team_id = $2)`,
      [f.leagueId, team],
    );
    await db.q("update public.matchups set week_count = 2 where id = $1", [id]);

    const wr = await makePlayer(db, "T7W_WR", "Two Week WR", "WR");
    await giveStats(db, wr, 1, { tackles_combined: 1 });
    await giveStats(db, wr, 2, { tackles_combined: 1 });
    await lineup(f.leagueId, team, 1, [[wr, "WR"]]);
    await lineup(f.leagueId, team, 2, [[wr, "WR"]]);

    await setRule(f.leagueId, "tackles_combined", 5);
    await db.q("select public.recompute_season_scores($1)", [f.leagueId]);
    assert.equal((await matchupScore(f.leagueId, team, 1)).score, 10);

    await setRule(f.leagueId, "tackles_combined", 0, ["WR"]);
    await db.q("select public.recompute_season_scores($1)", [f.leagueId]);
    assert.equal((await matchupScore(f.leagueId, team, 1)).score, 0);
  });
});

describe("T-007 zero override: the rescore at the end of 0039", () => {
  /** The DO block that closes the migration, run again on demand. */
  const migrationRescore = (() => {
    const sql = readFileSync(
      join(MIGRATIONS_DIR, "0039_zero_point_position_overrides.sql"),
      "utf8",
    );
    const start = sql.lastIndexOf("do $$");
    assert.ok(start > 0, "0039 ends with a DO block");
    return sql.slice(start);
  })();

  test("stale scores in open matchups are fixed; final matchups keep their score", async () => {
    const f = await buildLeague(db, "t007-migration");
    const other = await buildLeague(db, "t007-migration-untouched");
    await db.actAs(f.commish);
    await db.q("select public.generate_schedule($1)", [f.leagueId]);

    const wr = await makePlayer(db, "T7G_WR", "Migrated WR", "WR");
    await giveStats(db, wr, 1, { tackles_combined: 1 });
    await giveStats(db, wr, 2, { tackles_combined: 1 });

    const team = f.teamIds[0];
    await lineup(f.leagueId, team, 1, [[wr, "WR"]]);
    await lineup(f.leagueId, team, 2, [[wr, "WR"]]);

    for (const l of [f, other]) {
      await setRule(l.leagueId, "tackles_combined", 5);
    }
    await db.q("select public.recompute_season_scores($1)", [f.leagueId]);
    await db.actAs(other.commish);
    await db.q("select public.recompute_season_scores($1)", [other.leagueId]);

    const week1 = await matchupScore(f.leagueId, team, 1);
    const week2 = await matchupScore(f.leagueId, team, 2);
    assert.equal(week1.score, 5);
    assert.equal(week2.score, 5);
    await db.q("update public.matchups set status = 'final' where id = $1", [week1.id]);

    // The state the live database is in before 0039: an override of 0
    // saved, but the scores computed while it was ignored.
    await db.q(
      `insert into public.league_scoring_rules (league_id, stat_key, points, positions)
       values ($1, 'tackles_combined', 0, '{WR}')`,
      [f.leagueId],
    );
    // A league whose override is nonzero is not a candidate.
    await setRule(other.leagueId, "tackles_combined", 7, ["WR"]);
    assert.equal(await actual(f.leagueId, wr, 1), 5, "stale before the migration");

    // Migrations run without a signed-in user.
    await db.actAs(null);
    await db.exec(migrationRescore);

    assert.equal(await scoreRow(f.leagueId, wr, 1), null);
    assert.equal(await scoreRow(f.leagueId, wr, 2), null);
    assert.equal((await matchupScore(f.leagueId, team, 1)).score, 5, "final matchup frozen");
    assert.equal((await matchupScore(f.leagueId, team, 2)).score, 0, "open matchup rescored");
    assert.equal(await actual(other.leagueId, wr, 1), 5, "other league not rescored by the migration");

    // Running it twice changes nothing.
    await db.exec(migrationRescore);
    assert.equal((await matchupScore(f.leagueId, team, 1)).score, 5);
    assert.equal((await matchupScore(f.leagueId, team, 2)).score, 0);
  });
});
