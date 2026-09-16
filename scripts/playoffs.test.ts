/**
 * Functional tests for playoff bracket generation.
 *
 * Brackets are easy to get subtly wrong -- an off-by-one in the byes
 * puts the wrong team on the couch -- and nobody notices until December,
 * so the seeding and pairing are checked explicitly.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, type TestDb } from "./lib/test-db.ts";
import {
  SEASON,
  buildLeague,
  giveStats,
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

/**
 * Adds `extra` more teams to a league, so a bracket has something to
 * work with beyond the four buildLeague creates.
 */
async function growLeague(f: Fixture, extra: number): Promise<string[]> {
  const ids: string[] = [];
  const code = await db.one<{ join_code: string }>(
    "select join_code from public.leagues where id = $1",
    [f.leagueId],
  );

  // A league is a fixed size now, so make room before inviting anyone.
  await db.actAs(f.commish);
  const size = await db.one<{ n: number }>(
    "select count(*)::int as n from public.teams where league_id = $1",
    [f.leagueId],
  );
  await db.q("select public.set_team_count($1, $2)", [
    f.leagueId,
    size.n + extra,
  ]);

  for (let i = 0; i < extra; i++) {
    const uid = await db.createUser(`extra${i}-${f.leagueId}@example.com`);
    await db.actAs(uid);
    const team = await db.one<{ join_league: string }>(
      "select public.join_league($1, $2) as join_league",
      [code.join_code, `Extra ${i}`],
    );
    ids.push(team.join_league);
  }

  await db.actAs(f.commish);
  return ids;
}

/**
 * Gives every team a distinct record by faking finished matchups, so
 * seeding is deterministic: the first team listed wins the most.
 */
async function seedRecords(f: Fixture, teamIds: string[]) {
  await db.q(
    "delete from public.matchups where league_id = $1 and is_playoff = false",
    [f.leagueId],
  );

  // Team i wins (teams - i) games against a rotating opponent.
  for (let i = 0; i < teamIds.length; i++) {
    const wins = teamIds.length - i;
    for (let w = 0; w < wins; w++) {
      const opponent = teamIds[(i + w + 1) % teamIds.length];
      if (opponent === teamIds[i]) continue;

      await db.q(
        `insert into public.matchups
           (league_id, season, week, home_team_id, away_team_id,
            home_score, away_score, status, is_playoff)
         values ($1, $2, $3, $4, $5, 100, 50, 'final', false)
         on conflict (league_id, season, week, home_team_id) do nothing`,
        [f.leagueId, SEASON, i * 20 + w + 1, teamIds[i], opponent],
      );
    }
  }
}

describe("custom playoff shapes", () => {
  /** A round that runs for `weeks` weeks. */
  async function configureRounds(
    leagueId: string,
    bracket: "winners" | "losers",
    weeks: number[],
  ) {
    for (let i = 0; i < weeks.length; i++) {
      await db.q(
        `insert into public.league_playoff_rounds
           (league_id, bracket, round_index, weeks)
         values ($1, $2, $3, $4)
         on conflict (league_id, bracket, round_index)
         do update set weeks = excluded.weeks`,
        [leagueId, bracket, i + 1, weeks[i]],
      );
    }
  }

  test("a two-week round is laid out as one matchup spanning both", async () => {
    const f = await buildLeague(db, "playoffs-twoweek");
    await db.q(
      "update public.leagues set playoff_teams = 4, playoff_start_week = 15 where id = $1",
      [f.leagueId],
    );
    // Semi-final over two weeks, final over one.
    await configureRounds(f.leagueId, "winners", [2, 1]);
    await seedRecords(f, f.teamIds);
    await db.q("select public.generate_playoffs($1)", [f.leagueId]);

    const games = await db.q<{ week: number; week_count: number }>(
      `select week, week_count from public.matchups
       where league_id = $1 and is_playoff`,
      [f.leagueId],
    );

    assert.equal(games.length, 2, "four teams, two semi-finals");
    assert.ok(
      games.every((g) => g.week === 15 && g.week_count === 2),
      "both start in week 15 and run for two",
    );
  });

  test("a two-week matchup scores the sum of both weeks", async () => {
    const f = await buildLeague(db, "playoffs-twoweek-score");
    await db.q(
      "update public.leagues set playoff_teams = 4, playoff_start_week = 15, current_week = 15 where id = $1",
      [f.leagueId],
    );
    await configureRounds(f.leagueId, "winners", [2, 1]);
    await seedRecords(f, f.teamIds);
    await db.q("select public.generate_playoffs($1)", [f.leagueId]);

    const game = await db.one<{
      id: string;
      home_team_id: string;
      week: number;
    }>(
      `select id, home_team_id, week from public.matchups
       where league_id = $1 and is_playoff and away_team_id is not null
       limit 1`,
      [f.leagueId],
    );

    // A starter scoring in each of the two weeks.
    const pid = await makePlayer(db, "PO_TWO_WK", "Two Week Man", "QB");
    await db.asSuperuser(async () => {
      await db.q(
        `insert into public.roster_players (league_id, team_id, player_id)
         values ($1, $2, $3)`,
        [f.leagueId, game.home_team_id, pid],
      );
      for (const [week, points] of [
        [15, 20],
        [16, 12],
      ]) {
        await db.q(
          `insert into public.lineup_entries
             (league_id, team_id, season, week, player_id, slot_key)
           values ($1, $2, $3, $4, $5, 'QB')`,
          [f.leagueId, game.home_team_id, SEASON, week, pid],
        );
        await db.q(
          `insert into public.player_week_scores
             (league_id, player_id, season, week, points)
           values ($1, $2, $3, $4, $5)`,
          [f.leagueId, pid, SEASON, week, points],
        );
      }
    });

    await db.actAs(f.commish);
    // Rescoring either week must produce the two-week total.
    await db.q("select public.recompute_matchup_scores($1, $2, $3)", [
      f.leagueId,
      SEASON,
      16,
    ]);

    const scored = await db.one<{ home_score: string }>(
      "select home_score from public.matchups where id = $1",
      [game.id],
    );
    assert.equal(Number(scored.home_score), 32, "20 in week 15 plus 12 in 16");
  });

  test("the final starts after a two-week semi, not the week after it began", async () => {
    const f = await buildLeague(db, "playoffs-offset");
    await db.q(
      "update public.leagues set playoff_teams = 4, playoff_start_week = 15 where id = $1",
      [f.leagueId],
    );
    await configureRounds(f.leagueId, "winners", [2, 1]);
    await seedRecords(f, f.teamIds);
    await db.q("select public.generate_playoffs($1)", [f.leagueId]);

    await db.q(
      `update public.matchups set status = 'final', home_score = 100, away_score = 50
       where league_id = $1 and is_playoff`,
      [f.leagueId],
    );
    await db.q("select public.advance_playoffs($1, $2)", [f.leagueId, 15]);

    const final = await db.one<{ week: number; week_count: number }>(
      `select week, week_count from public.matchups
       where league_id = $1 and is_playoff and week > 16`,
      [f.leagueId],
    );
    assert.equal(final.week, 17, "the semi occupied 15 and 16");
    assert.equal(final.week_count, 1);
  });

  test("losers drop into a consolation bracket when one is configured", async () => {
    const f = await buildLeague(db, "playoffs-losers");
    await db.q(
      "update public.leagues set playoff_teams = 4, playoff_start_week = 15 where id = $1",
      [f.leagueId],
    );
    await configureRounds(f.leagueId, "winners", [1, 1]);
    await configureRounds(f.leagueId, "losers", [1]);
    await seedRecords(f, f.teamIds);
    await db.q("select public.generate_playoffs($1)", [f.leagueId]);

    await db.q(
      `update public.matchups set status = 'final', home_score = 100, away_score = 50
       where league_id = $1 and is_playoff`,
      [f.leagueId],
    );
    await db.q("select public.advance_playoffs($1, $2)", [f.leagueId, 15]);

    const losers = await db.q<{ playoff_round: string }>(
      `select playoff_round from public.matchups
       where league_id = $1 and bracket = 'losers'`,
      [f.leagueId],
    );
    assert.equal(losers.length, 1, "the two beaten semi-finalists meet");
    assert.equal(losers[0].playoff_round, "Consolation");
  });

  test("without a losers bracket configured, nothing extra is created", async () => {
    const f = await buildLeague(db, "playoffs-no-losers");
    await db.q(
      "update public.leagues set playoff_teams = 4, playoff_start_week = 15 where id = $1",
      [f.leagueId],
    );
    await seedRecords(f, f.teamIds);
    await db.q("select public.generate_playoffs($1)", [f.leagueId]);
    await db.q(
      `update public.matchups set status = 'final', home_score = 100, away_score = 50
       where league_id = $1 and is_playoff`,
      [f.leagueId],
    );
    await db.q("select public.advance_playoffs($1, $2)", [f.leagueId, 15]);

    const losers = await db.q(
      "select 1 from public.matchups where league_id = $1 and bracket = 'losers'",
      [f.leagueId],
    );
    assert.equal(losers.length, 0);
  });
});

describe("playoffs", () => {
  test("six teams give the top two a bye and pair 3v6, 4v5", async () => {
    const f = await buildLeague(db, "playoffs-six");
    const extra = await growLeague(f, 2);
    const all = [...f.teamIds, ...extra];

    await db.q(
      "update public.leagues set playoff_teams = 6, playoff_start_week = 15 where id = $1",
      [f.leagueId],
    );
    await seedRecords(f, all);
    await db.q("select public.generate_playoffs($1)", [f.leagueId]);

    const seeds = await db.q<{ team_id: string; seed: number }>(
      "select team_id, seed from public.playoff_seeds where league_id = $1 order by seed",
      [f.leagueId],
    );
    assert.equal(seeds.length, 6, "six teams make the playoffs");

    const bySeed = new Map(seeds.map((s) => [s.seed, s.team_id]));

    const games = await db.q<{
      home_team_id: string;
      away_team_id: string | null;
      playoff_round: string;
    }>(
      `select home_team_id, away_team_id, playoff_round
       from public.matchups
       where league_id = $1 and is_playoff and week = 15`,
      [f.leagueId],
    );

    const byes = games.filter((g) => g.away_team_id === null);
    assert.equal(byes.length, 2, "the top two seeds sit out");
    assert.deepEqual(
      byes.map((b) => b.home_team_id).sort(),
      [bySeed.get(1)!, bySeed.get(2)!].sort(),
    );

    const played = games.filter((g) => g.away_team_id !== null);
    assert.equal(played.length, 2);

    const pairs = played
      .map((g) => {
        const home = seeds.find((s) => s.team_id === g.home_team_id)!.seed;
        const away = seeds.find((s) => s.team_id === g.away_team_id)!.seed;
        return [home, away];
      })
      .sort((a, b) => a[0] - b[0]);

    assert.deepEqual(pairs, [
      [3, 6],
      [4, 5],
    ]);
  });

  test("four teams need no byes", async () => {
    const f = await buildLeague(db, "playoffs-four");
    await db.q(
      "update public.leagues set playoff_teams = 4, playoff_start_week = 15 where id = $1",
      [f.leagueId],
    );
    await seedRecords(f, f.teamIds);
    await db.q("select public.generate_playoffs($1)", [f.leagueId]);

    const games = await db.q<{ away_team_id: string | null }>(
      `select away_team_id from public.matchups
       where league_id = $1 and is_playoff and week = 15`,
      [f.leagueId],
    );

    assert.equal(games.length, 2, "two semifinals");
    assert.equal(
      games.filter((g) => g.away_team_id === null).length,
      0,
      "nobody gets a bye in a four-team bracket",
    );
  });

  test("the round is named for how many teams are in it", async () => {
    const f = await buildLeague(db, "playoffs-naming");
    await db.q(
      "update public.leagues set playoff_teams = 4, playoff_start_week = 15 where id = $1",
      [f.leagueId],
    );
    await seedRecords(f, f.teamIds);
    await db.q("select public.generate_playoffs($1)", [f.leagueId]);

    const rounds = await db.q<{ playoff_round: string }>(
      `select distinct playoff_round from public.matchups
       where league_id = $1 and is_playoff and week = 15`,
      [f.leagueId],
    );
    assert.deepEqual(rounds.map((r) => r.playoff_round), ["Semifinal"]);
  });

  test("winners advance and are re-seeded highest against lowest", async () => {
    const f = await buildLeague(db, "playoffs-advance");
    const extra = await growLeague(f, 2);
    const all = [...f.teamIds, ...extra];

    await db.q(
      "update public.leagues set playoff_teams = 6, playoff_start_week = 15, current_week = 15 where id = $1",
      [f.leagueId],
    );
    await seedRecords(f, all);
    await db.q("select public.generate_playoffs($1)", [f.leagueId]);

    // The home side wins every first round game.
    await db.q(
      `update public.matchups
         set home_score = 100, away_score = 90, status = 'final'
       where league_id = $1 and is_playoff and week = 15`,
      [f.leagueId],
    );

    const created = await db.one<{ advance_playoffs: number }>(
      "select public.advance_playoffs($1, 15) as advance_playoffs",
      [f.leagueId],
    );
    assert.equal(created.advance_playoffs, 2, "four survivors, two semifinals");

    const seeds = await db.q<{ team_id: string; seed: number }>(
      "select team_id, seed from public.playoff_seeds where league_id = $1",
      [f.leagueId],
    );
    const seedOf = new Map(seeds.map((s) => [s.team_id, s.seed]));

    const next = await db.q<{ home_team_id: string; away_team_id: string }>(
      `select home_team_id, away_team_id from public.matchups
       where league_id = $1 and is_playoff and week = 16`,
      [f.leagueId],
    );

    // Survivors are seeds 1, 2 (byes) and 3, 4 (home winners).
    const pairs = next
      .map((g) => [seedOf.get(g.home_team_id)!, seedOf.get(g.away_team_id)!])
      .sort((a, b) => a[0] - b[0]);

    assert.deepEqual(pairs, [
      [1, 4],
      [2, 3],
    ]);
  });

  test("advancing is refused while a game is still unfinished", async () => {
    const f = await buildLeague(db, "playoffs-unfinished");
    await db.q(
      "update public.leagues set playoff_teams = 4, playoff_start_week = 15 where id = $1",
      [f.leagueId],
    );
    await seedRecords(f, f.teamIds);
    await db.q("select public.generate_playoffs($1)", [f.leagueId]);

    await assert.rejects(
      () => db.q("select public.advance_playoffs($1, 15)", [f.leagueId]),
      /not final/,
    );
  });

  test("the last winner standing completes the season", async () => {
    const f = await buildLeague(db, "playoffs-champion");
    await db.q(
      "update public.leagues set playoff_teams = 2, playoff_start_week = 15 where id = $1",
      [f.leagueId],
    );
    await seedRecords(f, f.teamIds);
    await db.q("select public.generate_playoffs($1)", [f.leagueId]);

    const final = await db.q<{ playoff_round: string }>(
      `select playoff_round from public.matchups
       where league_id = $1 and is_playoff and week = 15`,
      [f.leagueId],
    );
    assert.deepEqual(final.map((r) => r.playoff_round), ["Championship"]);

    await db.q(
      `update public.matchups
         set home_score = 120, away_score = 90, status = 'final'
       where league_id = $1 and is_playoff and week = 15`,
      [f.leagueId],
    );
    await db.q("select public.advance_playoffs($1, 15)", [f.leagueId]);

    const leagueRow = await db.one<{ status: string }>(
      "select status from public.leagues where id = $1",
      [f.leagueId],
    );
    assert.equal(leagueRow.status, "complete");
  });

  test("generating the bracket twice replaces it rather than duplicating", async () => {
    const f = await buildLeague(db, "playoffs-regenerate");
    await db.q(
      "update public.leagues set playoff_teams = 4, playoff_start_week = 15 where id = $1",
      [f.leagueId],
    );
    await seedRecords(f, f.teamIds);

    await db.q("select public.generate_playoffs($1)", [f.leagueId]);
    await db.q("select public.generate_playoffs($1)", [f.leagueId]);

    const games = await db.q(
      "select 1 from public.matchups where league_id = $1 and is_playoff",
      [f.leagueId],
    );
    assert.equal(games.length, 2);
  });
});

describe("finalizing weeks", () => {
  /** Starts `playerId` for `teamId` in `week`. */
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

  test("finalizing a week updates the standings with no manual SQL", async () => {
    const f = await buildLeague(db, "finalize-standings");
    await db.q("select public.generate_schedule($1)", [f.leagueId]);

    const home = f.teamIds[0];
    const game = await db.one<{ home_team_id: string; away_team_id: string }>(
      `select home_team_id, away_team_id from public.matchups
       where league_id = $1 and week = 1
         and (home_team_id = $2 or away_team_id = $2)`,
      [f.leagueId, home],
    );
    const opponent =
      game.home_team_id === home ? game.away_team_id : game.home_team_id;

    const pid = await makePlayer(db, "FIN_STAND_WR", "Finalize Receiver", "WR");
    await giveStats(db, pid, 1, { receiving_yards: 100 }); // 10 points
    await start(f.leagueId, home, pid, 1);

    const before = await db.one<{ games_played: number }>(
      "select games_played from public.standings where team_id = $1",
      [home],
    );
    assert.equal(Number(before.games_played), 0, "nothing counts until final");

    const closed = await db.one<{ n: number }>(
      "select public.finalize_week($1, $2, 1) as n",
      [f.leagueId, SEASON],
    );
    assert.equal(closed.n, 2, "both week 1 matchups close");

    const rows = await db.q<{
      team_id: string;
      wins: number;
      losses: number;
      games_played: number;
      points_for: string;
    }>(
      `select team_id, wins, losses, games_played, points_for
       from public.standings where league_id = $1`,
      [f.leagueId],
    );
    const byTeam = new Map(rows.map((r) => [r.team_id, r]));
    assert.equal(Number(byTeam.get(home)!.wins), 1);
    assert.equal(
      Number(byTeam.get(home)!.points_for),
      10,
      "rescored on the way in",
    );
    assert.equal(Number(byTeam.get(opponent)!.losses), 1);
    assert.ok(
      rows.every((r) => Number(r.games_played) === 1),
      "every team has exactly one game counted",
    );

    const week2 = await db.q(
      "select 1 from public.matchups where league_id = $1 and week = 2 and status = 'final'",
      [f.leagueId],
    );
    assert.equal(week2.length, 0, "week 2 is left alone");
  });

  test("only the commissioner can finalize a week", async () => {
    const f = await buildLeague(db, "finalize-auth");
    await db.q("select public.generate_schedule($1)", [f.leagueId]);

    await db.actAs(f.managers[0]);
    await assert.rejects(
      () => db.q("select public.finalize_week($1, $2, 1)", [f.leagueId, SEASON]),
      /Only the commissioner/,
    );
    await db.actAs(f.commish);
  });

  test("the commissioner cannot finalize a week that has not been played", async () => {
    const f = await buildLeague(db, "finalize-future");
    await db.q("select public.generate_schedule($1)", [f.leagueId]);

    // Week 10 has no games at all; week 11 kicks off in the future.
    await db.q(
      `insert into public.nfl_games (id, season, week, home_team, away_team, kickoff_at)
       values ($1, $2, 11, 'KC', 'BUF', now() + interval '3 days')`,
      [`${SEASON}_11_FIN_FUTURE`, SEASON],
    );

    for (const week of [10, 11]) {
      await assert.rejects(
        () => db.q("select public.finalize_week($1, $2, $3)", [f.leagueId, SEASON, week]),
        /has not been played yet/,
        `week ${week} is refused`,
      );
    }

    const closed = await db.q(
      "select 1 from public.matchups where league_id = $1 and status = 'final'",
      [f.leagueId],
    );
    assert.equal(closed.length, 0, "nothing was frozen");
  });

  test("a two-week matchup stays open after week one, closes after week two, then advances", async () => {
    const f = await buildLeague(db, "finalize-twoweek");
    await db.q(
      "update public.leagues set playoff_teams = 4, playoff_start_week = 15, current_week = 15 where id = $1",
      [f.leagueId],
    );
    await db.q(
      `insert into public.league_playoff_rounds
         (league_id, bracket, round_index, weeks)
       values ($1, 'winners', 1, 2), ($1, 'winners', 2, 1)`,
      [f.leagueId],
    );
    await seedRecords(f, f.teamIds);
    await db.q("select public.generate_playoffs($1)", [f.leagueId]);

    const semi = await db.one<{ id: string; home_team_id: string }>(
      `select id, home_team_id from public.matchups
       where league_id = $1 and is_playoff and away_team_id is not null
       order by home_team_id limit 1`,
      [f.leagueId],
    );
    const pid = await makePlayer(db, "FIN_TWO_WR", "Two Week Receiver", "WR");
    await giveStats(db, pid, 15, { receiving_yards: 200 }); // 20
    await giveStats(db, pid, 16, { receiving_yards: 120 }); // 12
    await start(f.leagueId, semi.home_team_id, pid, 15);
    await start(f.leagueId, semi.home_team_id, pid, 16);

    const statuses = async () =>
      (
        await db.q<{ status: string }>(
          "select status from public.matchups where league_id = $1 and is_playoff",
          [f.leagueId],
        )
      ).map((r) => r.status);

    const afterWeek1 = await db.one<{ n: number }>(
      "select public.finalize_week($1, $2, 15) as n",
      [f.leagueId, SEASON],
    );
    assert.equal(afterWeek1.n, 0, "week 15 is only the first half");
    assert.ok(
      (await statuses()).every((s) => s !== "final"),
      "neither semi-final is closed after one week",
    );
    await assert.rejects(
      () => db.q("select public.advance_playoffs($1, 15)", [f.leagueId]),
      /not final/,
      "advancing is still refused mid-round",
    );

    const afterWeek2 = await db.one<{ n: number }>(
      "select public.finalize_week($1, $2, 16) as n",
      [f.leagueId, SEASON],
    );
    assert.equal(afterWeek2.n, 2, "both semi-finals close after week 16");
    assert.ok((await statuses()).every((s) => s === "final"));

    const scored = await db.one<{ home_score: string }>(
      "select home_score from public.matchups where id = $1",
      [semi.id],
    );
    assert.equal(Number(scored.home_score), 32, "both weeks count");

    // Again, for both weeks: nothing changes.
    const again = await db.one<{ n: number }>(
      "select public.finalize_week($1, $2, 16) as n",
      [f.leagueId, SEASON],
    );
    assert.equal(again.n, 0, "a second run closes nothing");
    await db.q("select public.finalize_week($1, $2, 15)", [f.leagueId, SEASON]);
    const unchanged = await db.one<{ home_score: string; status: string }>(
      "select home_score, status from public.matchups where id = $1",
      [semi.id],
    );
    assert.equal(Number(unchanged.home_score), 32);
    assert.equal(unchanged.status, "final");

    const created = await db.one<{ n: number }>(
      "select public.advance_playoffs($1, 15) as n",
      [f.leagueId],
    );
    assert.equal(created.n, 1, "the final is created");
    const final = await db.q(
      "select 1 from public.matchups where league_id = $1 and is_playoff and week = 17",
      [f.leagueId],
    );
    assert.equal(final.length, 1, "in week 17, after the two-week semi");
  });

  test("the scheduled job finalizes completed weeks only, and is safe to repeat", async () => {
    const f = await buildLeague(db, "finalize-cron");
    await db.q("select public.generate_schedule($1)", [f.leagueId]);
    await db.q("update public.leagues set status = 'in_season' where id = $1", [
      f.leagueId,
    ]);

    // Week 3 runs Thursday to Monday night; week 4 has not started.
    await db.q(
      `insert into public.nfl_games
         (id, season, week, home_team, away_team, kickoff_at, status)
       values ($1, $4, 3, 'KC', 'BUF', '2026-09-25T00:15:00Z', 'final'),
              ($2, $4, 3, 'BUF', 'KC', '2026-09-29T00:15:00Z', 'final'),
              ($3, $4, 4, 'KC', 'BUF', '2026-10-02T00:15:00Z', 'scheduled')`,
      [`${SEASON}_03_FIN_A`, `${SEASON}_03_FIN_B`, `${SEASON}_04_FIN_A`, SEASON],
    );

    const job = (asOf: string) =>
      db.q<{ league_id: string; week: number; closed: number }>(
        "select * from public.finalize_completed_weeks(interval '36 hours', $1::timestamptz)",
        [asOf],
      );
    const mine = (rows: { league_id: string; week: number; closed: number }[]) =>
      rows
        .filter((r) => r.league_id === f.leagueId)
        .map((r) => [r.week, r.closed]);
    const finalWeeks = async () =>
      (
        await db.q<{ week: number }>(
          `select distinct week from public.matchups
           where league_id = $1 and status = 'final' order by week`,
          [f.leagueId],
        )
      ).map((r) => r.week);

    // The jobs run with no user.
    await db.actAs(null);

    // A browser session is refused outright.
    await db.q("select set_config('request.jwt.claims', $1, false)", [
      JSON.stringify({ role: "authenticated" }),
    ]);
    await assert.rejects(() => job("2026-10-01T00:00:00Z"), /scheduled jobs/);
    await db.q("select set_config('request.jwt.claims', '', false)");

    // Monday night's game ended hours ago: too soon.
    assert.deepEqual(mine(await job("2026-09-29T06:00:00Z")), []);
    assert.deepEqual(await finalWeeks(), []);

    // Old enough, but only the live feed has reported: the official
    // numbers (and their corrections) have not landed, so stay open.
    const pid = await makePlayer(db, "FIN_CRON_WR", "Cron Receiver", "WR");
    const statLine = (gameId: string, source: "live" | "final") =>
      db.q(
        `insert into public.player_game_stats
           (player_id, game_id, season, week, stats, source)
         values ($1, $2, $3, 3, '{"receiving_yards": 50}', $4)
         on conflict (player_id, game_id) do update set source = excluded.source`,
        [pid, gameId, SEASON, source],
      );
    await statLine(`${SEASON}_03_FIN_A`, "live");
    await statLine(`${SEASON}_03_FIN_B`, "live");
    assert.deepEqual(mine(await job("2026-09-30T16:00:00Z")), []);
    assert.deepEqual(await finalWeeks(), [], "live-only stats keep the week open");

    // One game official, the other not yet: still open.
    await statLine(`${SEASON}_03_FIN_A`, "final");
    assert.deepEqual(mine(await job("2026-09-30T16:00:00Z")), []);
    assert.deepEqual(await finalWeeks(), [], "every game needs official stats");

    await statLine(`${SEASON}_03_FIN_B`, "final");

    // Both official and a day and a half on: week 3 closes, week 4 does not.
    assert.deepEqual(mine(await job("2026-09-30T16:00:00Z")), [[3, 2]]);
    assert.deepEqual(await finalWeeks(), [3]);

    const standings = await db.q<{ games_played: number }>(
      "select games_played from public.standings where league_id = $1",
      [f.leagueId],
    );
    assert.ok(standings.every((r) => Number(r.games_played) === 1));

    // Running it again is a no-op.
    assert.deepEqual(mine(await job("2026-09-30T16:00:00Z")), []);
    assert.deepEqual(await finalWeeks(), [3]);

    await db.actAs(f.commish);
  });
});
