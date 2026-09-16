/**
 * Edge cases for closing out matchups (T-006, migration 0038).
 *
 * A final matchup is never rescored, so closing one too early -- or
 * never closing one -- is silent and permanent. Each case here is a way
 * a real season has of being awkward: three-week rounds, byes, a
 * postponed game, leagues in different states, ties, stat lines that
 * are only partly official.
 *
 * NFL games are shared by every league in the database, so each test
 * uses its own weeks.
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

let db: TestDb;

before(async () => {
  db = await createTestDb();
});

after(async () => {
  await db.close();
});

const LONG_AGO = "2026-01-01T00:00:00Z";

async function game(
  id: string,
  week: number,
  kickoff: string | null,
  status: "scheduled" | "in_progress" | "final" | "postponed",
) {
  await db.q(
    `insert into public.nfl_games
       (id, season, week, home_team, away_team, kickoff_at, status)
     values ($1, $2, $3, 'KC', 'BUF', $4, $5)
     on conflict (id) do update
       set kickoff_at = excluded.kickoff_at, status = excluded.status`,
    [id, SEASON, week, kickoff, status],
  );
}

async function stat(
  playerId: string,
  gameId: string,
  week: number,
  stats: Record<string, number>,
  source: "live" | "final",
) {
  await db.q(
    `insert into public.player_game_stats
       (player_id, game_id, season, week, stats, source)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (player_id, game_id) do update
       set stats = excluded.stats, source = excluded.source`,
    [playerId, gameId, SEASON, week, JSON.stringify(stats), source],
  );
}

/** A week whose one game is over, official and long ago. */
async function completeWeek(week: number, tag: string) {
  const id = `${SEASON}_${String(week).padStart(2, "0")}_EDGE_${tag}`;
  await game(id, week, LONG_AGO, "final");
  const pid = await makePlayer(db, `EDGE_OFF_${tag}`, `Official ${tag}`, "TE");
  await stat(pid, id, week, { receiving_yards: 1 }, "final");
  return id;
}

async function start(
  leagueId: string,
  teamId: string,
  playerId: string,
  week: number,
) {
  await db.q(
    `insert into public.lineup_entries
       (league_id, team_id, season, week, player_id, slot_key)
     values ($1, $2, $3, $4, $5, 'WR')`,
    [leagueId, teamId, SEASON, week, playerId],
  );
}

async function matchup(
  f: Fixture,
  week: number,
  weekCount: number,
  home: string,
  away: string | null,
  opts: { bracket?: "winners" | "losers"; playoff?: boolean } = {},
): Promise<string> {
  const row = await db.one<{ id: string }>(
    `insert into public.matchups
       (league_id, season, week, week_count, bracket,
        home_team_id, away_team_id, is_playoff)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [
      f.leagueId,
      SEASON,
      week,
      weekCount,
      opts.bracket ?? "winners",
      home,
      away,
      opts.playoff ?? true,
    ],
  );
  return row.id;
}

async function statusOf(id: string): Promise<string> {
  return (
    await db.one<{ status: string }>(
      "select status from public.matchups where id = $1",
      [id],
    )
  ).status;
}

async function finalizeAs(f: Fixture, week: number): Promise<number> {
  await db.actAs(f.commish);
  const r = await db.one<{ n: number }>(
    "select public.finalize_week($1, $2, $3) as n",
    [f.leagueId, SEASON, week],
  );
  return r.n;
}

/** The scheduled job only touches leagues whose season is under way. */
async function inSeason(...fixtures: Fixture[]) {
  for (const f of fixtures) {
    await db.q("update public.leagues set status = 'in_season' where id = $1", [
      f.leagueId,
    ]);
  }
}

/** Runs the scheduled job as the jobs do, returning this league's rows. */
async function job(asOf: string, leagueId?: string) {
  await db.actAs(null);
  const rows = await db.q<{ league_id: string; week: number; closed: number }>(
    "select * from public.finalize_completed_weeks(interval '36 hours', $1::timestamptz)",
    [asOf],
  );
  return rows
    .filter((r) => !leagueId || r.league_id === leagueId)
    .map((r) => [r.week, r.closed]);
}

describe("finalizing: matchup length", () => {
  test("a three-week matchup closes only after its third week, scoring all three", async () => {
    await completeWeek(1, "W1");
    await completeWeek(2, "W2");
    await completeWeek(3, "W3");

    const f = await buildLeague(db, "edge-threeweek");
    const [a, b] = f.teamIds;
    const id = await matchup(f, 1, 3, a, b);

    const pid = await makePlayer(db, "EDGE_3W_WR", "Three Week WR", "WR");
    for (const [week, yards] of [[1, 100], [2, 50], [3, 30]] as const) {
      const gid = `${SEASON}_0${week}_EDGE_3W`;
      await game(gid, week, LONG_AGO, "final");
      await stat(pid, gid, week, { receiving_yards: yards }, "final");
      await start(f.leagueId, a, pid, week);
    }

    assert.equal(await finalizeAs(f, 1), 0, "week 1 of 3 closes nothing");
    assert.equal(await finalizeAs(f, 2), 0, "week 2 of 3 closes nothing");
    assert.equal(await statusOf(id), "scheduled");
    assert.equal(await finalizeAs(f, 3), 1, "week 3 closes it");
    assert.equal(await statusOf(id), "final");

    const m = await db.one<{ home_score: string }>(
      "select home_score from public.matchups where id = $1",
      [id],
    );
    assert.equal(Number(m.home_score), 18, "10 + 5 + 3 across the three weeks");
  });

  test("the scheduled job leaves a three-week matchup open until its last week is complete", async () => {
    await completeWeek(4, "W4");
    await completeWeek(5, "W5");
    await game(`${SEASON}_06_EDGE_LATE`, 6, "2026-10-20T00:15:00Z", "final");

    const f = await buildLeague(db, "edge-threeweek-job");
    await inSeason(f);
    const id = await matchup(f, 4, 3, f.teamIds[0], f.teamIds[1]);

    assert.deepEqual(await job("2026-10-20T06:00:00Z", f.leagueId), []);
    assert.equal(await statusOf(id), "scheduled", "weeks 4-5 done is not enough");

    // Official stats and 36 hours later.
    const pid = await makePlayer(db, "EDGE_W6_OFF", "W6 Official", "TE");
    await stat(pid, `${SEASON}_06_EDGE_LATE`, 6, { receiving_yards: 1 }, "final");
    assert.deepEqual(await job("2026-10-21T12:15:00Z", f.leagueId), [[6, 1]]);
    assert.equal(await statusOf(id), "final");
  });

  test("finalizing week N closes one-week N and two-week (N-1..N), leaving two-week (N..N+1) open", async () => {
    await completeWeek(7, "W7");
    await completeWeek(8, "W8");

    const f = await buildLeague(db, "edge-mixed-lengths");
    const [a, b, c, d] = f.teamIds;
    const endsIn8 = await matchup(f, 7, 2, a, b, { bracket: "losers" });
    const single = await matchup(f, 8, 1, c, d);
    const startsIn8 = await matchup(f, 8, 2, a, b);

    assert.equal(await finalizeAs(f, 8), 2);
    assert.equal(await statusOf(endsIn8), "final");
    assert.equal(await statusOf(single), "final");
    assert.equal(await statusOf(startsIn8), "scheduled");
  });

  test("a two-week matchup stays open if a game in its first week never finished", async () => {
    // Week 9: one game never got a score (as nflverse shows a cancelled game).
    await game(`${SEASON}_09_EDGE_STUCK`, 9, LONG_AGO, "scheduled");
    await completeWeek(10, "W10");

    const f = await buildLeague(db, "edge-first-week-gap");
    await inSeason(f);
    const id = await matchup(f, 9, 2, f.teamIds[0], f.teamIds[1]);
    // A one-week game ending the same week is not held hostage by it.
    const single = await matchup(f, 10, 1, f.teamIds[2], f.teamIds[3]);

    assert.deepEqual(await job("2026-12-31T00:00:00Z", f.leagueId), [[10, 1]]);
    assert.equal(await statusOf(id), "scheduled", "week 9 is not complete");
    assert.equal(await statusOf(single), "final");
  });
});

describe("finalizing: byes", () => {
  test("a regular-season bye closes with the week and never counts in the standings", async () => {
    await completeWeek(1, "BYE_REG");
    const f = await buildLeague(db, "edge-reg-bye");

    const code = await db.one<{ join_code: string }>(
      "select join_code from public.leagues where id = $1",
      [f.leagueId],
    );
    await db.q("select public.set_team_count($1, 5)", [f.leagueId]);
    const uid = await db.createUser("fifth-edge-reg-bye@example.com");
    await db.actAs(uid);
    await db.q("select public.join_league($1, 'Fifth')", [code.join_code]);
    await db.actAs(f.commish);

    await db.q("select public.generate_schedule($1)", [f.leagueId]);
    assert.equal(await finalizeAs(f, 1), 3, "two games and a bye close");

    const open = await db.q(
      "select 1 from public.matchups where league_id = $1 and week = 1 and status <> 'final'",
      [f.leagueId],
    );
    assert.equal(open.length, 0);

    const rows = await db.q<{ games_played: number; ties: number }>(
      "select games_played, ties from public.standings where league_id = $1",
      [f.leagueId],
    );
    assert.equal(rows.length, 5);
    assert.equal(
      rows.filter((r) => Number(r.games_played) === 1).length,
      4,
      "four teams played",
    );
    assert.equal(
      rows.filter((r) => Number(r.games_played) === 0).length,
      1,
      "the bye team has no game counted",
    );
  });

  test("a playoff round with byes closes after its last week and advances", async () => {
    await completeWeek(15, "BYE_P15");
    await completeWeek(16, "BYE_P16");

    const f = await buildLeague(db, "edge-playoff-bye");
    const [s1, s2, s3, s4] = f.teamIds;
    await db.q(
      "update public.leagues set playoff_teams = 4, playoff_start_week = 15, current_week = 15 where id = $1",
      [f.leagueId],
    );
    await db.q(
      `insert into public.league_playoff_rounds (league_id, bracket, round_index, weeks)
       values ($1, 'winners', 1, 2), ($1, 'winners', 2, 1)`,
      [f.leagueId],
    );
    await db.q(
      `insert into public.playoff_seeds (league_id, season, team_id, seed)
       values ($1, $2, $3, 1), ($1, $2, $4, 2), ($1, $2, $5, 3), ($1, $2, $6, 4)`,
      [f.leagueId, SEASON, s1, s2, s3, s4],
    );
    // Seeds 1 and 2 sit out; 3 plays 4, all over weeks 15-16.
    const bye1 = await matchup(f, 15, 2, s1, null);
    const bye2 = await matchup(f, 15, 2, s2, null);
    const game34 = await matchup(f, 15, 2, s3, s4);

    const pid = await makePlayer(db, "EDGE_BYE_WR", "Bye Round WR", "WR");
    await stat(pid, `${SEASON}_16_EDGE_BYE_P16`, 16, { receiving_yards: 40 }, "final");
    await start(f.leagueId, s4, pid, 16);

    assert.equal(await finalizeAs(f, 15), 0);
    await assert.rejects(
      () => db.q("select public.advance_playoffs($1, 15)", [f.leagueId]),
      /not final/,
    );

    assert.equal(await finalizeAs(f, 16), 3, "the game and both byes close");
    for (const id of [bye1, bye2, game34]) {
      assert.equal(await statusOf(id), "final");
    }

    await db.q("select public.advance_playoffs($1, 15)", [f.leagueId]);
    const next = await db.q<{ home_team_id: string; away_team_id: string | null; week: number }>(
      `select home_team_id, away_team_id, week from public.matchups
       where league_id = $1 and is_playoff and bracket = 'winners' and week = 17`,
      [f.leagueId],
    );
    assert.ok(next.length >= 1, "the next round is created in week 17");
    const teams = next.flatMap((m) => [m.home_team_id, m.away_team_id]);
    assert.ok(teams.includes(s4), "seed 4 won its game (4 pts to 0) and advanced");
    assert.ok(!teams.includes(s3), "seed 3 is out");
  });
});

describe("finalizing: when is a week complete", () => {
  test("a postponed game does not hold the week open", async () => {
    await completeWeek(11, "PPD_OK");
    await game(`${SEASON}_11_EDGE_PPD`, 11, LONG_AGO, "postponed");

    const r = await db.one<{ ok: boolean }>(
      "select public.nfl_week_is_complete($1, 11) as ok",
      [SEASON],
    );
    assert.equal(r.ok, true);
  });

  test("a past game that never got a score (nflverse's cancelled game) holds the week open", async () => {
    await completeWeek(12, "CXL_OK");
    // syncGames only ever writes 'scheduled' or 'final'; nothing writes 'postponed'.
    await game(`${SEASON}_12_EDGE_CXL`, 12, LONG_AGO, "scheduled");

    const r = await db.one<{ ok: boolean }>(
      "select public.nfl_week_is_complete($1, 12) as ok",
      [SEASON],
    );
    assert.equal(r.ok, false, "the commissioner override is the only way out");
  });

  test("the grace period is 36 hours from the last kickoff, inclusive", async () => {
    await game(`${SEASON}_13_EDGE_GRACE`, 13, "2026-12-08T01:15:00Z", "final");
    const pid = await makePlayer(db, "EDGE_GRACE", "Grace", "TE");
    await stat(pid, `${SEASON}_13_EDGE_GRACE`, 13, { receiving_yards: 1 }, "final");

    const at = async (asOf: string) =>
      (
        await db.one<{ ok: boolean }>(
          "select public.nfl_week_is_complete($1, 13, interval '36 hours', $2::timestamptz) as ok",
          [SEASON, asOf],
        )
      ).ok;
    assert.equal(await at("2026-12-09T13:14:59Z"), false);
    assert.equal(await at("2026-12-09T13:15:00Z"), true);
  });

  test("preseason games do not count toward, or block, a week", async () => {
    await db.q(
      `insert into public.nfl_games (id, season, week, season_type, home_team, away_team, kickoff_at, status)
       values ($1, $2, 14, 'PRE', 'KC', 'BUF', now() + interval '1 day', 'scheduled')`,
      [`${SEASON}_14_EDGE_PRE`, SEASON],
    );
    const onlyPre = await db.one<{ ok: boolean }>(
      "select public.nfl_week_is_complete($1, 14) as ok",
      [SEASON],
    );
    assert.equal(onlyPre.ok, false, "a week of only preseason games is not a played week");

    await completeWeek(14, "PRE_REG");
    const withReg = await db.one<{ ok: boolean }>(
      "select public.nfl_week_is_complete($1, 14) as ok",
      [SEASON],
    );
    assert.equal(withReg.ok, true, "the future preseason game is ignored");
  });

  test("the previous week closes while the current week is still being played", async () => {
    await game(`${SEASON}_17_EDGE_PREV`, 17, "2026-12-29T01:15:00Z", "final");
    await game(`${SEASON}_18_EDGE_CUR_A`, 18, "2027-01-01T01:15:00Z", "final");
    await game(`${SEASON}_18_EDGE_CUR_B`, 18, "2027-01-04T18:00:00Z", "in_progress");
    const pid = await makePlayer(db, "EDGE_PREV", "Prev", "TE");
    await stat(pid, `${SEASON}_17_EDGE_PREV`, 17, { receiving_yards: 1 }, "final");
    await stat(pid, `${SEASON}_18_EDGE_CUR_A`, 18, { receiving_yards: 1 }, "final");

    const f = await buildLeague(db, "edge-prev-week");
    await inSeason(f);
    const prev = await matchup(f, 17, 1, f.teamIds[0], f.teamIds[1], { playoff: false });
    const cur = await matchup(f, 18, 1, f.teamIds[0], f.teamIds[1], { playoff: false });

    assert.deepEqual(await job("2027-01-04T20:00:00Z", f.leagueId), [[17, 1]]);
    assert.equal(await statusOf(prev), "final");
    assert.equal(await statusOf(cur), "scheduled");
  });

  test("official stats for only some players of a game are enough, and the frozen score survives later corrections", async () => {
    await game(`${SEASON}_19_EDGE_PART`, 19, LONG_AGO, "final");
    const official = await makePlayer(db, "EDGE_PART_OFF", "Part Official", "WR");
    const liveOnly = await makePlayer(db, "EDGE_PART_LIVE", "Part Live", "WR");
    await stat(official, `${SEASON}_19_EDGE_PART`, 19, { receiving_yards: 100 }, "final");
    await stat(liveOnly, `${SEASON}_19_EDGE_PART`, 19, { receiving_yards: 50 }, "live");

    const f = await buildLeague(db, "edge-partial-official");
    await inSeason(f);
    const [a, b] = f.teamIds;
    const id = await matchup(f, 19, 1, a, b, { playoff: false });
    await start(f.leagueId, a, official, 19);
    await start(f.leagueId, b, liveOnly, 19);

    assert.deepEqual(await job("2027-02-01T00:00:00Z", f.leagueId), [[19, 1]]);
    const frozen = await db.one<{ home_score: string; away_score: string }>(
      "select home_score, away_score from public.matchups where id = $1",
      [id],
    );
    assert.equal(Number(frozen.home_score), 10);
    assert.equal(Number(frozen.away_score), 5, "the live line counts at its provisional value");

    // The official line for the other player arrives later, bigger.
    await stat(liveOnly, `${SEASON}_19_EDGE_PART`, 19, { receiving_yards: 200 }, "final");
    await db.actAs(null);
    await db.q("select public.recompute_week_scores($1, $2, 19)", [f.leagueId, SEASON]);
    const after = await db.one<{ home_score: string; away_score: string; status: string }>(
      "select home_score, away_score, status from public.matchups where id = $1",
      [id],
    );
    assert.equal(after.status, "final");
    assert.equal(Number(after.away_score), 5, "a final matchup is not rescored");
  });
});

describe("finalizing: leagues and permissions", () => {
  test("the job handles several leagues in different states in one pass", async () => {
    await completeWeek(20, "MULTI_20");
    await game(`${SEASON}_21_EDGE_MULTI`, 21, "2027-02-10T00:00:00Z", "scheduled");

    const open = await buildLeague(db, "edge-multi-open");
    const done = await buildLeague(db, "edge-multi-done");
    const twoWeek = await buildLeague(db, "edge-multi-twoweek");
    await inSeason(open, done, twoWeek);

    const openA = await matchup(open, 20, 1, open.teamIds[0], open.teamIds[1], { playoff: false });
    const openB = await matchup(open, 20, 1, open.teamIds[2], open.teamIds[3], { playoff: false });
    const done20 = await matchup(done, 20, 1, done.teamIds[0], done.teamIds[1], { playoff: false });
    const done21 = await matchup(done, 21, 1, done.teamIds[0], done.teamIds[1], { playoff: false });
    const spans = await matchup(twoWeek, 20, 2, twoWeek.teamIds[0], twoWeek.teamIds[1]);

    assert.equal(await finalizeAs(done, 20), 1, "commissioner closed week 20 by hand");

    const asOf = "2027-02-01T00:00:00Z";
    await db.actAs(null);
    const rows = (
      await db.q<{ league_id: string; week: number; closed: number }>(
        "select * from public.finalize_completed_weeks(interval '36 hours', $1::timestamptz)",
        [asOf],
      )
    ).filter((r) => [open.leagueId, done.leagueId, twoWeek.leagueId].includes(r.league_id));

    assert.deepEqual(
      rows.map((r) => [r.league_id, r.week, r.closed]),
      [[open.leagueId, 20, 2]],
      "only the open league's week 20 closes",
    );
    assert.equal(await statusOf(openA), "final");
    assert.equal(await statusOf(openB), "final");
    assert.equal(await statusOf(done20), "final");
    assert.equal(await statusOf(done21), "scheduled");
    assert.equal(await statusOf(spans), "scheduled", "week 21 has not been played");
  });

  test("the job skips leagues whose season is not under way", async () => {
    await completeWeek(23, "STATUS_23");

    const byStatus = new Map<string, { f: Fixture; id: string }>();
    for (const status of ["setup", "drafting", "complete", "in_season", "playoffs"]) {
      const f = await buildLeague(db, `edge-status-${status}`);
      await db.q("update public.leagues set status = $2 where id = $1", [
        f.leagueId,
        status,
      ]);
      const id = await matchup(f, 23, 1, f.teamIds[0], f.teamIds[1], { playoff: false });
      byStatus.set(status, { f, id });
    }

    await job("2027-03-01T00:00:00Z");

    for (const status of ["setup", "drafting", "complete"]) {
      assert.equal(
        await statusOf(byStatus.get(status)!.id),
        "scheduled",
        `a league in ${status} is left alone`,
      );
    }
    for (const status of ["in_season", "playoffs"]) {
      assert.equal(await statusOf(byStatus.get(status)!.id), "final", `${status} closes`);
    }

    // Once a skipped league starts its season, the job picks it up.
    const setup = byStatus.get("setup")!;
    await inSeason(setup.f);
    assert.deepEqual(await job("2027-03-01T00:00:00Z", setup.f.leagueId), [[23, 1]]);
  });

  test("a commissioner of league A cannot finalize league B, directly or via a mistyped season", async () => {
    await completeWeek(22, "AUTH_22");
    const a = await buildLeague(db, "edge-auth-a");
    const b = await buildLeague(db, "edge-auth-b");
    const bMatch = await matchup(b, 22, 1, b.teamIds[0], b.teamIds[1], { playoff: false });

    await db.actAs(a.commish);
    await assert.rejects(
      () => db.q("select public.finalize_week($1, $2, 22)", [b.leagueId, SEASON]),
      /Only the commissioner/,
    );
    assert.equal(await statusOf(bMatch), "scheduled");

    // A manager in league B is not its commissioner either.
    await db.actAs(b.managers[0]);
    await assert.rejects(
      () => db.q("select public.finalize_week($1, $2, 22)", [b.leagueId, SEASON]),
      /Only the commissioner/,
    );
    assert.equal(await statusOf(bMatch), "scheduled");
  });

  test("a tie at finalization is a tie in the standings", async () => {
    await game(`${SEASON}_03_EDGE_TIE`, 3, LONG_AGO, "final");
    const p1 = await makePlayer(db, "EDGE_TIE_1", "Tie One", "WR");
    const p2 = await makePlayer(db, "EDGE_TIE_2", "Tie Two", "WR");
    await stat(p1, `${SEASON}_03_EDGE_TIE`, 3, { receiving_yards: 70 }, "final");
    await stat(p2, `${SEASON}_03_EDGE_TIE`, 3, { receiving_yards: 70 }, "final");

    const f = await buildLeague(db, "edge-tie");
    const [a, b, c, d] = f.teamIds;
    await matchup(f, 3, 1, a, b, { playoff: false });
    await matchup(f, 3, 1, c, d, { playoff: false }); // 0-0, nobody set a lineup
    await start(f.leagueId, a, p1, 3);
    await start(f.leagueId, b, p2, 3);

    assert.equal(await finalizeAs(f, 3), 2);
    const rows = await db.q<{ wins: number; losses: number; ties: number; win_pct: string; points_for: string }>(
      "select wins, losses, ties, win_pct, points_for from public.standings where league_id = $1",
      [f.leagueId],
    );
    for (const r of rows) {
      assert.equal(Number(r.wins), 0);
      assert.equal(Number(r.losses), 0);
      assert.equal(Number(r.ties), 1);
      assert.equal(Number(r.win_pct), 0.5);
    }
    assert.deepEqual(
      rows.map((r) => Number(r.points_for)).sort((x, y) => x - y),
      [0, 0, 7, 7],
    );
  });
});

describe("finalizing: grants", () => {
  let rls: TestDb;

  before(async () => {
    rls = await createTestDb({ enforceRls: true });
  });

  after(async () => {
    await rls.close();
  });

  test("a signed-in user cannot run the every-league job", async () => {
    const uid = await rls.createUser("grants-user@example.com");
    await rls.actAs(uid);
    await assert.rejects(
      () => rls.q("select * from public.finalize_completed_weeks()"),
      /permission denied/,
    );
  });

  test("a signed-out visitor cannot call finalize_week at all", async () => {
    await rls.actAs(null);
    await rls.asSuperuser(async () => {
      await rls.exec("grant usage on schema public to anon; set role anon;");
      try {
        await assert.rejects(
          () =>
            rls.q("select public.finalize_week(gen_random_uuid(), 2026, 1)"),
          /permission denied/,
        );
        await assert.rejects(
          () => rls.q("select * from public.finalize_completed_weeks()"),
          /permission denied/,
        );
      } finally {
        await rls.exec("reset role;");
      }
    });
  });

  // close_matchups does no authorisation of its own: its grants are all
  // that stop anyone freezing any league's matchups.
  test("a signed-in user cannot call close_matchups", async () => {
    const uid = await rls.createUser("grants-close@example.com");
    await rls.actAs(uid);
    await assert.rejects(
      () =>
        rls.q("select public.close_matchups(gen_random_uuid(), 2026, 1, null)"),
      /permission denied/,
    );
    // Control: the same role does reach finalize_week, so the refusal
    // above is the grant and not a role that can call nothing.
    await assert.rejects(
      () => rls.q("select public.finalize_week(gen_random_uuid(), 2026, 1)"),
      /Only the commissioner/,
    );
  });

  test("a signed-out visitor cannot call close_matchups", async () => {
    await rls.actAs(null);
    await rls.asSuperuser(async () => {
      await rls.exec("grant usage on schema public to anon; set role anon;");
      try {
        await assert.rejects(
          () =>
            rls.q("select public.close_matchups(gen_random_uuid(), 2026, 1, null)"),
          /permission denied/,
        );
      } finally {
        await rls.exec("reset role;");
      }
    });
  });

  test("a direct call with a specific id list is refused too", async () => {
    const uid = await rls.createUser("grants-close-ids@example.com");
    await rls.actAs(uid);
    await assert.rejects(
      () =>
        rls.q(
          "select public.close_matchups(gen_random_uuid(), 2026, 1, array[gen_random_uuid()])",
        ),
      /permission denied/,
    );
  });
});
