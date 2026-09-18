/**
 * Per-league seeding and tiebreak settings (T-010, migration 0041).
 *
 * Three things used to be decided for every league at once: the seeding
 * order, whether the winners bracket re-seeded, and who took a tied
 * playoff game. Each is now a setting, so each is tested at both ends --
 * the order the settings produce, and the bracket that comes out.
 *
 * The game tiebreak is also played out on paper through
 * src/lib/playoff-bracket.ts, which is what the admin screen explains,
 * and the two are compared case by case so they cannot drift.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, type TestDb } from "./lib/test-db.ts";
import { SEASON, buildLeague, makePlayer, type Fixture } from "./lib/fixtures.ts";
import {
  DEFAULT_SEEDING_SETTINGS,
  cleanSeedingSettings,
  playoffAdvancer,
  type PlayoffTiebreak,
  type SeedingTiebreaker,
} from "../src/lib/playoff-bracket.ts";
import { makesPlayoffs, orderStandings } from "../src/lib/standings-order.ts";

let db: TestDb;

before(async () => {
  db = await createTestDb();
});

after(async () => {
  await db.close();
});

// Fixtures -------------------------------------------------------------------

/** A league of `size` teams, none of which has played anything yet. */
async function makeLeague(name: string, size: number): Promise<Fixture & {
  teamIds: string[];
}> {
  const f = await buildLeague(db, name);
  await db.actAs(f.commish);
  await db.q("select public.set_team_count($1, $2)", [f.leagueId, size]);

  const code = await db.one<{ join_code: string }>(
    "select join_code from public.leagues where id = $1",
    [f.leagueId],
  );

  for (let i = f.teamIds.length; i < size; i++) {
    const uid = await db.createUser(`extra${i}-${name}@example.com`);
    await db.actAs(uid);
    await db.q("select public.join_league($1, $2)", [
      code.join_code,
      `Extra ${i}`,
    ]);
  }

  await db.actAs(f.commish);
  const rows = await db.q<{ id: string }>(
    "select id from public.teams where league_id = $1 order by created_at, id",
    [f.leagueId],
  );
  assert.equal(rows.length, size);
  return { ...f, teamIds: rows.map((r) => r.id) };
}

let gameWeek = 0;

/** One finished regular season game. Weeks never repeat, so nothing collides. */
async function playGame(
  leagueId: string,
  home: string,
  away: string,
  homeScore: number,
  awayScore: number,
) {
  gameWeek += 1;
  await db.q(
    `insert into public.matchups
       (league_id, season, week, home_team_id, away_team_id,
        home_score, away_score, status, is_playoff)
     values ($1, $2, $3, $4, $5, $6, $7, 'final', false)`,
    [leagueId, SEASON, gameWeek, home, away, homeScore, awayScore],
  );
}

/**
 * Team i beats every team after it, so the standings read exactly in
 * the order of `teamIds` and nothing is ever tied. `score` decides what
 * the two sides put up, so points for can be steered independently of
 * the record.
 */
async function roundRobin(
  leagueId: string,
  teamIds: string[],
  score: (winner: number, loser: number) => [number, number] = () => [100, 50],
) {
  for (let i = 0; i < teamIds.length; i++) {
    for (let j = i + 1; j < teamIds.length; j++) {
      const [w, l] = score(i, j);
      await playGame(leagueId, teamIds[i], teamIds[j], w, l);
    }
  }
}

async function setTiebreakers(leagueId: string, keys: SeedingTiebreaker[]) {
  await db.q("update public.leagues set seeding_tiebreakers = $2 where id = $1", [
    leagueId,
    keys,
  ]);
}

async function seedingOrder(leagueId: string): Promise<string[]> {
  const rows = await db.q<{ team_id: string }>(
    "select team_id from public.league_seeding_order($1) order by seed",
    [leagueId],
  );
  return rows.map((r) => r.team_id);
}

interface Game {
  id: string;
  week: number;
  home_team_id: string;
  away_team_id: string | null;
  status: string;
}

async function playoffGames(
  leagueId: string,
  bracket: "winners" | "losers",
  week?: number,
) {
  return db.q<Game>(
    `select id, week, home_team_id, away_team_id, status
     from public.matchups
     where league_id = $1 and is_playoff and bracket = $2
       and ($3::int is null or week = $3)
     order by week, bracket_slot, home_team_id`,
    [leagueId, bracket, week ?? null],
  );
}

async function seedsOf(leagueId: string, bracket: "winners" | "losers") {
  const rows = await db.q<{ team_id: string }>(
    `select team_id from public.playoff_seeds
     where league_id = $1 and bracket = $2 order by seed`,
    [leagueId, bracket],
  );
  return rows.map((r) => r.team_id);
}

/** Finishes every game of a round. `result` gives the two scores. */
async function finish(
  leagueId: string,
  bracket: "winners" | "losers",
  week: number,
  result: (game: Game) => [number, number] = () => [100, 50],
) {
  for (const g of await playoffGames(leagueId, bracket, week)) {
    if (g.status === "final") continue;
    const [home, away] = result(g);
    await db.q(
      `update public.matchups
         set home_score = $2, away_score = $3, status = 'final' where id = $1`,
      [g.id, home, away],
    );
  }
}

async function advance(leagueId: string, week: number) {
  return (
    await db.one<{ n: number }>("select public.advance_playoffs($1, $2) as n", [
      leagueId,
      week,
    ])
  ).n;
}

/** Who the database says goes through, keyed by matchup. */
async function advancers(leagueId: string): Promise<Map<string, string>> {
  const rows = await db.q<{ matchup_id: string; team_id: string }>(
    "select matchup_id, team_id from public.playoff_advancers_for($1, $2)",
    [leagueId, SEASON],
  );
  return new Map(rows.map((r) => [r.matchup_id, r.team_id]));
}

/**
 * Puts `points` on a team's bench for one week.
 *
 * `slotKey` null leaves the player off the lineup altogether, which is
 * what a rostered player nobody placed looks like -- the matchup screen
 * counts him on the bench, so team_bench_points has to as well.
 */
async function benchPoints(
  leagueId: string,
  teamId: string,
  week: number,
  points: number,
  slotKey: string | null = "BN",
) {
  const playerId = await makePlayer(
    db,
    `bench-${teamId}-${week}-${slotKey ?? "none"}`,
    "Bench Guy",
    "RB",
  );
  await db.q(
    `insert into public.roster_players (league_id, team_id, player_id)
     values ($1, $2, $3) on conflict do nothing`,
    [leagueId, teamId, playerId],
  );
  await db.q(
    `insert into public.player_week_scores (league_id, player_id, season, week, points)
     values ($1, $2, $3, $4, $5)
     on conflict (league_id, player_id, season, week) do update
       set points = excluded.points`,
    [leagueId, playerId, SEASON, week, points],
  );
  if (slotKey !== null) {
    await db.q(
      `insert into public.lineup_entries
         (league_id, team_id, season, week, player_id, slot_key)
       values ($1, $2, $3, $4, $5, $6)`,
      [leagueId, teamId, SEASON, week, playerId, slotKey],
    );
  }
}

async function benchTotal(
  leagueId: string,
  teamId: string,
  week: number,
  weeks = 1,
) {
  const row = await db.one<{ points: string }>(
    "select public.team_bench_points($1, $2, $3, $4, $5) as points",
    [leagueId, SEASON, teamId, week, weeks],
  );
  return Number(row.points);
}

/**
 * The three-way tie the seeding tests are built on; see the comment on
 * "seeding tiebreakers" for what each tiebreaker makes of it.
 */
async function threeWayTie(leagueId: string, t: string[]) {
  await playGame(leagueId, t[0], t[1], 100, 90);
  await playGame(leagueId, t[0], t[2], 100, 95);
  await playGame(leagueId, t[1], t[2], 100, 96);
  await playGame(leagueId, t[3], t[0], 100, 80);
  await playGame(leagueId, t[3], t[0], 100, 80);
  await playGame(leagueId, t[1], t[3], 100, 50);
  await playGame(leagueId, t[3], t[1], 100, 80);
  await playGame(leagueId, t[2], t[3], 100, 99);
  await playGame(leagueId, t[2], t[3], 100, 99);
}

// Seeding --------------------------------------------------------------------

describe("seeding tiebreakers", () => {
  /**
   * Four teams. T3 finishes 3-3 and is seeded first on wins; T0, T1 and
   * T2 all finish 2-2, so everything below is settled by the league's
   * own list.
   *
   *   head to head   T0 beat both, T1 split, T2 lost both -> T0, T1, T2
   *   points for     391, 370, 360                        -> T2, T1, T0
   *   points against 398, 385, 346                        -> T2, T0, T1
   *
   * Three different answers from one set of standings, so a test that
   * passes can only be reading the setting.
   */
  let leagueId: string;
  let t: string[];

  before(async () => {
    const f = await makeLeague("seed-tiebreak", 4);
    leagueId = f.leagueId;
    t = f.teamIds;

    await threeWayTie(leagueId, t);
  });

  test("the standings behind the fixture are what the comment says", async () => {
    const rows = await db.q<{
      team_id: string;
      wins: number;
      losses: number;
      points_for: string;
      points_against: string;
    }>(
      `select team_id, wins, losses, points_for, points_against
       from public.standings where league_id = $1`,
      [leagueId],
    );
    const by = new Map(rows.map((r) => [r.team_id, r]));
    assert.deepEqual(
      t.map((id) => [Number(by.get(id)!.wins), Number(by.get(id)!.losses)]),
      [[2, 2], [2, 2], [2, 2], [3, 3]],
    );
    assert.deepEqual(
      t.map((id) => Number(by.get(id)!.points_for)),
      [360, 370, 391, 548],
    );
    assert.deepEqual(
      t.map((id) => Number(by.get(id)!.points_against)),
      [385, 346, 398, 540],
    );
  });

  test("a three-way tie is broken by the record inside the tie", async () => {
    const pct = await db.q<{ team_id: string; win_pct: string }>(
      "select team_id, win_pct from public.head_to_head_win_pct($1, $2)",
      [leagueId, [t[0], t[1], t[2]]],
    );
    const by = new Map(pct.map((r) => [r.team_id, Number(r.win_pct)]));
    assert.deepEqual([by.get(t[0]), by.get(t[1]), by.get(t[2])], [1, 0.5, 0]);

    await setTiebreakers(leagueId, ["head_to_head", "points_for"]);
    assert.deepEqual(await seedingOrder(leagueId), [t[3], t[0], t[1], t[2]]);
  });

  test("teams that never met come back level, so the next tiebreaker decides", async () => {
    const pct = await db.q<{ team_id: string; win_pct: string }>(
      "select team_id, win_pct from public.head_to_head_win_pct($1, $2)",
      [leagueId, [t[0]]],
    );
    assert.deepEqual(pct.map((r) => Number(r.win_pct)), [0.5]);
  });

  test("points for seeds the higher-scoring team first", async () => {
    await setTiebreakers(leagueId, ["points_for"]);
    assert.deepEqual(await seedingOrder(leagueId), [t[3], t[2], t[1], t[0]]);
  });

  test("points against seeds the team that was shot at hardest first", async () => {
    await setTiebreakers(leagueId, ["points_against"]);
    assert.deepEqual(await seedingOrder(leagueId), [t[3], t[2], t[0], t[1]]);
  });

  test("the list is applied in order: head to head first, then head to head second", async () => {
    // Head to head separates all three, so whatever follows it is never
    // reached; put it second and points for leads instead.
    await setTiebreakers(leagueId, ["head_to_head", "points_against"]);
    assert.deepEqual(await seedingOrder(leagueId), [t[3], t[0], t[1], t[2]]);

    await setTiebreakers(leagueId, ["points_for", "head_to_head"]);
    assert.deepEqual(await seedingOrder(leagueId), [t[3], t[2], t[1], t[0]]);
  });

  test("division record is accepted and does nothing until divisions exist", async () => {
    await setTiebreakers(leagueId, []);
    const none = await seedingOrder(leagueId);

    await setTiebreakers(leagueId, ["division_record"]);
    assert.deepEqual(
      await seedingOrder(leagueId),
      none,
      "listing it changes nothing (T-041)",
    );

    await setTiebreakers(leagueId, ["division_record", "points_for"]);
    assert.deepEqual(
      await seedingOrder(leagueId),
      [t[3], t[2], t[1], t[0]],
      "and it does not swallow the tiebreaker after it",
    );
  });

  test("an unknown tiebreaker cannot be stored", async () => {
    await assert.rejects(
      () => setTiebreakers(leagueId, ["coin_toss" as SeedingTiebreaker]),
      /seeding_tiebreakers/,
    );
  });

  test("the coin flip lands the same way every time it is asked", async () => {
    await setTiebreakers(leagueId, ["coin_flip"]);
    const first = await seedingOrder(leagueId);
    const second = await seedingOrder(leagueId);
    assert.deepEqual(first, second, "same league, same season, same order");
    assert.deepEqual([...first].sort(), [...t].sort(), "everyone is seeded");
    assert.equal(first[0], t[3], "it never overrules wins and losses");

    // The same flip, asked directly, is also stable and does separate
    // two teams -- which is the whole point of having it last.
    const flips = await db.q<{ flip: string }>(
      `select public.seeding_coin_flip($1, $2, x)::text as flip
       from unnest($3::uuid[]) as x`,
      [leagueId, SEASON, t],
    );
    const again = await db.q<{ flip: string }>(
      `select public.seeding_coin_flip($1, $2, x)::text as flip
       from unnest($3::uuid[]) as x`,
      [leagueId, SEASON, t],
    );
    assert.deepEqual(flips, again);
    assert.equal(new Set(flips.map((f) => f.flip)).size, t.length);
  });

  test("the bracket is seeded by the setting, not by a second copy of the rules", async () => {
    await setTiebreakers(leagueId, ["points_for"]);
    await db.q(
      `update public.leagues
         set playoff_teams = 4, playoff_start_week = 15, current_week = 15
       where id = $1`,
      [leagueId],
    );
    await db.q("select public.generate_playoffs($1)", [leagueId]);
    assert.deepEqual(await seedsOf(leagueId, "winners"), [
      t[3],
      t[2],
      t[1],
      t[0],
    ]);
  });
});

describe("a league that has configured nothing", () => {
  test("seeds on head to head then points for, and keeps working", async () => {
    const f = await makeLeague("seed-default", 4);
    const saved = await db.one<{
      seeding_tiebreakers: string[];
      playoff_reseed: string;
      playoff_tiebreak: string;
      losers_tiebreak: string;
    }>(
      `select seeding_tiebreakers, playoff_reseed, playoff_tiebreak,
              losers_tiebreak
       from public.leagues where id = $1`,
      [f.leagueId],
    );
    assert.deepEqual(saved.seeding_tiebreakers, ["head_to_head", "points_for"]);
    assert.equal(saved.playoff_reseed, "fixed");
    assert.equal(saved.playoff_tiebreak, "higher_seed");
    assert.equal(saved.losers_tiebreak, "higher_seed");
    assert.deepEqual(
      {
        tiebreakers: saved.seeding_tiebreakers,
        winnersReseed: saved.playoff_reseed,
        winnersTiebreak: saved.playoff_tiebreak,
        losersTiebreak: saved.losers_tiebreak,
      },
      DEFAULT_SEEDING_SETTINGS,
      "the admin screen and the database start from the same place",
    );

    await roundRobin(f.leagueId, f.teamIds);
    await db.q(
      `update public.leagues
         set playoff_teams = 4, playoff_start_week = 15, current_week = 15
       where id = $1`,
      [f.leagueId],
    );
    await db.q("select public.generate_playoffs($1)", [f.leagueId]);

    assert.deepEqual(await seedsOf(f.leagueId, "winners"), f.teamIds);

    await finish(f.leagueId, "winners", 15);
    assert.equal(await advance(f.leagueId, 15), 1, "a final is drawn");
    await finish(f.leagueId, "winners", 16);
    await advance(f.leagueId, 16);
    const status = await db.one<{ status: string }>(
      "select status from public.leagues where id = $1",
      [f.leagueId],
    );
    assert.equal(status.status, "complete");
  });
});

// Fixed vs re-seeded ---------------------------------------------------------

describe("the winners bracket keeps its draw or re-seeds", () => {
  /**
   * Eight teams, seeds 1-8 in order. Seed 8 upsets seed 1 in round one;
   * everyone else holds serve. Survivors are 8, 2, 3 and 4, which the
   * two settings then pair differently, and differently again in the
   * final.
   */
  async function playTwoRounds(name: string, reseed: "fixed" | "reseed") {
    const f = await makeLeague(name, 8);
    await roundRobin(f.leagueId, f.teamIds);
    await db.q(
      `update public.leagues
         set playoff_teams = 8, playoff_start_week = 15, current_week = 15,
             playoff_reseed = $2
       where id = $1`,
      [f.leagueId, reseed],
    );
    await db.q("select public.generate_playoffs($1)", [f.leagueId]);

    const seeds = await seedsOf(f.leagueId, "winners");
    assert.deepEqual(seeds, f.teamIds);

    // Round one: the away side wins only the 1v8 game.
    await finish(f.leagueId, "winners", 15, (g) =>
      g.home_team_id === seeds[0] ? [50, 100] : [100, 50],
    );
    assert.equal(await advance(f.leagueId, 15), 2);

    const seedNo = new Map(seeds.map((id, i) => [id, i + 1]));
    const pairsIn = async (week: number) =>
      (await playoffGames(f.leagueId, "winners", week))
        .map((g) => [seedNo.get(g.home_team_id)!, seedNo.get(g.away_team_id!)!])
        .sort((a, b) => a[0] - b[0]);

    const round2 = await pairsIn(16);

    await finish(f.leagueId, "winners", 16);
    assert.equal(await advance(f.leagueId, 16), 1);
    const round3 = await pairsIn(17);

    return { round2, round3 };
  }

  test("re-seeding pairs the best left against the worst left", async () => {
    const { round2, round3 } = await playTwoRounds("bracket-reseed", "reseed");
    assert.deepEqual(round2, [[2, 8], [3, 4]], "2v8 and 3v4");
    assert.deepEqual(round3, [[2, 3]], "the two home winners meet");
  });

  test("a fixed bracket sends the winner of 1v8 on to meet the winner of 4v5", async () => {
    const { round2, round3 } = await playTwoRounds("bracket-fixed", "fixed");
    assert.deepEqual(round2, [[2, 3], [8, 4]], "seed 8 inherits seed 1's half");
    assert.deepEqual(round3, [[8, 2]], "the two halves meet in the final");
  });
});

// Game tiebreaks -------------------------------------------------------------

describe("a tied playoff game", () => {
  const TIEBREAKS: PlayoffTiebreak[] = [
    "higher_seed",
    "bench_points",
    "points_for",
  ];

  test("every option, in both directions, matches the paper rules", async () => {
    const home = "11111111-1111-1111-1111-111111111111";
    const away = "22222222-2222-2222-2222-222222222222";

    for (const tiebreak of TIEBREAKS) {
      for (const losersAdvance of [false, true]) {
        for (const [homeScore, awayScore] of [
          [100, 90],
          [90, 100],
          [100, 100],
        ]) {
          for (const [homeKey, awayKey] of [
            [0, 0],
            [30, 10],
            [10, 30],
          ]) {
            // Seeds both ways round, and missing altogether: a fixed
            // draw can put either seed at home.
            for (const [homeSeed, awaySeed] of [
              [1, 4],
              [4, 1],
              [null, null],
            ] as [number | null, number | null][]) {
              const row = await db.one<{ who: string }>(
                `select public.playoff_game_advancer($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as who`,
                [
                  home,
                  away,
                  homeScore,
                  awayScore,
                  losersAdvance,
                  tiebreak,
                  homeKey,
                  awayKey,
                  homeSeed,
                  awaySeed,
                ],
              );
              const paper = playoffAdvancer({
                homeScore,
                awayScore,
                losersAdvance,
                tiebreak,
                homeKey,
                awayKey,
                homeSeed,
                awaySeed,
              });
              assert.equal(
                row.who === home ? "home" : "away",
                paper,
                `${tiebreak} / losersAdvance=${losersAdvance} / ${homeScore}-${awayScore} / keys ${homeKey}-${awayKey} / seeds ${homeSeed}-${awaySeed}`,
              );
            }
          }
        }
      }
    }
  });

  test("a bye goes through whatever the settings say", async () => {
    const home = "11111111-1111-1111-1111-111111111111";
    for (const tiebreak of TIEBREAKS) {
      const row = await db.one<{ who: string | null }>(
        `select public.playoff_game_advancer($1, null, 0, 0, true, $2, 0, 99, 7, 1) as who`,
        [home, tiebreak],
      );
      assert.equal(row.who, home);
    }
  });

  test("higher_seed reads the seed, not the side of the draw", async () => {
    const home = "11111111-1111-1111-1111-111111111111";
    const away = "22222222-2222-2222-2222-222222222222";

    // A fixed bracket puts the winner of 1v8 at home against the winner
    // of 4v5, so the home side can hold the worse seed. The better seed
    // goes through either way.
    for (const losersAdvance of [false, true]) {
      const worseAtHome = await db.one<{ who: string }>(
        `select public.playoff_game_advancer($1, $2, 100, 100, $3, 'higher_seed', 0, 0, 8, 4) as who`,
        [home, away, losersAdvance],
      );
      assert.equal(worseAtHome.who, away, "seed 4 beats seed 8");

      const betterAtHome = await db.one<{ who: string }>(
        `select public.playoff_game_advancer($1, $2, 100, 100, $3, 'higher_seed', 0, 0, 1, 4) as who`,
        [home, away, losersAdvance],
      );
      assert.equal(betterAtHome.who, home, "seed 1 beats seed 4");
    }

    // With no seeds to compare -- a bracket built before they were
    // written -- the home side falls back in.
    const noSeeds = await db.one<{ who: string }>(
      `select public.playoff_game_advancer($1, $2, 100, 100, true, 'higher_seed', 0, 0, null, null) as who`,
      [home, away],
    );
    assert.equal(noSeeds.who, home);
  });
});

describe("bench points settle a tied championship game", () => {
  test("the bigger bench goes through, beating the seeding", async () => {
    const f = await makeLeague("tiebreak-bench", 4);
    await roundRobin(f.leagueId, f.teamIds);
    await db.q(
      `update public.leagues
         set playoff_teams = 4, playoff_start_week = 15, current_week = 15,
             playoff_tiebreak = 'bench_points'
       where id = $1`,
      [f.leagueId],
    );
    await db.q("select public.generate_playoffs($1)", [f.leagueId]);
    const seeds = await seedsOf(f.leagueId, "winners");

    // Seed 4 left 30 on the bench, seed 1 left 5.
    await benchPoints(f.leagueId, seeds[0], 15, 5);
    await benchPoints(f.leagueId, seeds[3], 15, 30);

    await finish(f.leagueId, "winners", 15, (g) =>
      g.home_team_id === seeds[0] ? [100, 100] : [100, 50],
    );

    const tied = (await playoffGames(f.leagueId, "winners", 15)).find(
      (g) => g.home_team_id === seeds[0],
    )!;
    assert.equal(
      (await advancers(f.leagueId)).get(tied.id),
      seeds[3],
      "the bench decides, so the lower seed goes through",
    );

    await advance(f.leagueId, 15);
    const final = (await playoffGames(f.leagueId, "winners", 16))[0];
    assert.deepEqual(
      [final.home_team_id, final.away_team_id].sort(),
      [seeds[1], seeds[3]].sort(),
      "and the bracket carries the same team on",
    );
  });

  test("with the default tiebreak the same game goes to the top seed", async () => {
    const f = await makeLeague("tiebreak-bench-off", 4);
    await roundRobin(f.leagueId, f.teamIds);
    await db.q(
      `update public.leagues
         set playoff_teams = 4, playoff_start_week = 15, current_week = 15
       where id = $1`,
      [f.leagueId],
    );
    await db.q("select public.generate_playoffs($1)", [f.leagueId]);
    const seeds = await seedsOf(f.leagueId, "winners");

    await benchPoints(f.leagueId, seeds[0], 15, 5);
    await benchPoints(f.leagueId, seeds[3], 15, 30);
    await finish(f.leagueId, "winners", 15, (g) =>
      g.home_team_id === seeds[0] ? [100, 100] : [100, 50],
    );

    const tied = (await playoffGames(f.leagueId, "winners", 15)).find(
      (g) => g.home_team_id === seeds[0],
    )!;
    assert.equal((await advancers(f.leagueId)).get(tied.id), seeds[0]);
  });
});

describe("bench points are the ones the matchup screen prints", () => {
  test("a rostered player nobody placed, or left in a deleted slot, still counts", async () => {
    const f = await makeLeague("bench-matches-screen", 4);
    const team = f.teamIds[0];

    await benchPoints(f.leagueId, team, 15, 12, "BN");
    await benchPoints(f.leagueId, team, 15, 7, null);
    await benchPoints(f.leagueId, team, 15, 3, "OLD_FLEX");
    await benchPoints(f.leagueId, team, 15, 100, "QB");

    assert.equal(
      await benchTotal(f.leagueId, team, 15),
      22,
      "bench + unplaced + orphaned slot; the starter is not bench",
    );
  });

  test("a two-week matchup counts both weeks", async () => {
    const f = await makeLeague("bench-two-weeks", 4);
    const team = f.teamIds[0];

    await benchPoints(f.leagueId, team, 15, 10, "BN");
    await benchPoints(f.leagueId, team, 16, 25, "BN");

    assert.equal(await benchTotal(f.leagueId, team, 15, 1), 10);
    assert.equal(await benchTotal(f.leagueId, team, 15, 2), 35);
  });

  test("a two-week playoff matchup is settled on both weeks together", async () => {
    const f = await makeLeague("bench-two-week-game", 4);
    await roundRobin(f.leagueId, f.teamIds);
    await db.q(
      `update public.leagues
         set playoff_teams = 4, playoff_start_week = 15, current_week = 15,
             playoff_tiebreak = 'bench_points'
       where id = $1`,
      [f.leagueId],
    );
    await db.q(
      `insert into public.league_playoff_rounds
         (league_id, bracket, round_index, name, weeks, teams, byes)
       values ($1, 'winners', 1, '', 2, null, 0),
              ($1, 'winners', 2, '', 1, null, 0)`,
      [f.leagueId],
    );
    await db.q("select public.generate_playoffs($1)", [f.leagueId]);
    const seeds = await seedsOf(f.leagueId, "winners");

    // Week 15 alone would send seed 1 through; over both weeks seed 4
    // left more on the bench and takes the tie.
    await benchPoints(f.leagueId, seeds[0], 15, 30);
    await benchPoints(f.leagueId, seeds[3], 15, 10);
    await benchPoints(f.leagueId, seeds[0], 16, 0);
    await benchPoints(f.leagueId, seeds[3], 16, 40);

    const games = await playoffGames(f.leagueId, "winners", 15);
    assert.ok(games.length > 0);
    await finish(f.leagueId, "winners", 15, (g) =>
      g.home_team_id === seeds[0] ? [100, 100] : [100, 50],
    );

    const tied = games.find((g) => g.home_team_id === seeds[0])!;
    assert.equal(
      (await advancers(f.leagueId)).get(tied.id),
      seeds[3],
      "30 + 0 loses to 10 + 40",
    );
  });
});

describe("a fixed bracket compares seeds, not sides of the draw", () => {
  /**
   * The repro from review round 1: six teams, a fixed toilet bowl, and
   * a tie in round two. A fixed draw pairs slots, so the team holding
   * slot 1 in round two is whoever came out of the 1v4 half -- the BEST
   * of the entrants, seeded last in a toilet bowl. Reading the tie as
   * "the home side goes through" sent that team down and let the worse
   * one escape.
   */
  test("a tied second round sends the better toilet seed down, not the home side", async () => {
    const f = await makeLeague("fixed-toilet-tie", 6);
    await roundRobin(f.leagueId, f.teamIds);
    await db.q(
      `update public.leagues
         set playoff_teams = 2, playoff_start_week = 15, current_week = 15,
             losers_bracket_enabled = true,
             losers_entrants = 'non_playoff_teams',
             losers_mode = 'toilet_bowl', losers_reseed = 'fixed',
             losers_start_week = 15
       where id = $1`,
      [f.leagueId],
    );
    await db.q(
      `insert into public.league_playoff_rounds
         (league_id, bracket, round_index, name, weeks, teams, byes)
       values ($1, 'losers', 1, '', 1, 4, 0),
              ($1, 'losers', 2, '', 1, null, 0)`,
      [f.leagueId],
    );
    await db.q("select public.generate_playoffs($1)", [f.leagueId]);

    // A toilet bowl seeds the worst record first.
    const losers = await seedsOf(f.leagueId, "losers");
    assert.deepEqual(losers, [
      f.teamIds[5],
      f.teamIds[4],
      f.teamIds[3],
      f.teamIds[2],
    ]);

    // Round one: the home sides win, so in a toilet bowl the away sides
    // -- seeds 4 and 3 -- are the ones that sink.
    await finish(f.leagueId, "winners", 15);
    await finish(f.leagueId, "losers", 15);
    await advance(f.leagueId, 15);

    const round2 = await playoffGames(f.leagueId, "losers", 16);
    assert.equal(round2.length, 1);
    assert.equal(round2[0].home_team_id, losers[3], "seed 4 inherits slot 1");
    assert.equal(round2[0].away_team_id, losers[2], "seed 3 holds slot 2");

    await finish(f.leagueId, "losers", 16, () => [80, 80]);
    assert.equal(
      (await advancers(f.leagueId)).get(round2[0].id),
      losers[2],
      "seed 3 is the better seed of the two, so it goes down; seed 4 escapes",
    );
  });
});

describe("points for settles a tied toilet bowl game", () => {
  test("the higher-scoring season escapes and the other team sinks", async () => {
    const f = await makeLeague("tiebreak-toilet-pf", 4);
    // The two teams that miss the playoffs: T2 and T3. A drawn game
    // leaves T3 with the worse record but the bigger season, so points
    // for and the seeding disagree -- the only way to tell them apart.
    await roundRobin(f.leagueId, f.teamIds);
    await playGame(f.leagueId, f.teamIds[3], f.teamIds[0], 400, 400);

    await db.q(
      `update public.leagues
         set playoff_teams = 2, playoff_start_week = 15, current_week = 15,
             losers_bracket_enabled = true,
             losers_entrants = 'non_playoff_teams',
             losers_mode = 'toilet_bowl', losers_reseed = 'reseed',
             losers_start_week = 15, losers_tiebreak = 'points_for'
       where id = $1`,
      [f.leagueId],
    );
    await db.q(
      `insert into public.league_playoff_rounds
         (league_id, bracket, round_index, name, weeks, teams, byes)
       values ($1, 'losers', 1, '', 1, 2, 0)`,
      [f.leagueId],
    );
    await db.q("select public.generate_playoffs($1)", [f.leagueId]);

    // A toilet bowl seeds the worst record first.
    const losers = await seedsOf(f.leagueId, "losers");
    assert.deepEqual(losers, [f.teamIds[3], f.teamIds[2]]);

    const pf = await db.q<{ team_id: string; points_for: string }>(
      "select team_id, points_for from public.standings where league_id = $1",
      [f.leagueId],
    );
    const pfBy = new Map(pf.map((r) => [r.team_id, Number(r.points_for)]));
    assert.ok(
      pfBy.get(f.teamIds[3])! > pfBy.get(f.teamIds[2])!,
      "the worst team scored the most",
    );

    await finish(f.leagueId, "losers", 15, () => [100, 100]);
    const game = (await playoffGames(f.leagueId, "losers", 15))[0];
    assert.equal(
      (await advancers(f.leagueId)).get(game.id),
      f.teamIds[2],
      "the bigger season wins the tie and escapes; the other team goes down",
    );
  });

  test("the same game under higher_seed sends the worse team down instead", async () => {
    const f = await makeLeague("tiebreak-toilet-seed", 4);
    await roundRobin(f.leagueId, f.teamIds);
    await playGame(f.leagueId, f.teamIds[3], f.teamIds[0], 400, 400);

    await db.q(
      `update public.leagues
         set playoff_teams = 2, playoff_start_week = 15, current_week = 15,
             losers_bracket_enabled = true,
             losers_entrants = 'non_playoff_teams',
             losers_mode = 'toilet_bowl', losers_reseed = 'reseed',
             losers_start_week = 15
       where id = $1`,
      [f.leagueId],
    );
    await db.q(
      `insert into public.league_playoff_rounds
         (league_id, bracket, round_index, name, weeks, teams, byes)
       values ($1, 'losers', 1, '', 1, 2, 0)`,
      [f.leagueId],
    );
    await db.q("select public.generate_playoffs($1)", [f.leagueId]);

    await finish(f.leagueId, "losers", 15, () => [100, 100]);
    const game = (await playoffGames(f.leagueId, "losers", 15))[0];
    assert.equal(
      (await advancers(f.leagueId)).get(game.id),
      f.teamIds[3],
      "the worst team keeps sinking, however many points it scored",
    );
  });
});

// The standings page ------------------------------------------------------------

interface Row {
  team_id: string;
  wins: number;
  losses: number;
  points_for: number;
}

/** The standings view's rows, as the page reads them. */
async function standingsRows(leagueId: string): Promise<Row[]> {
  return db.q<Row>(
    `select team_id, wins::int as wins, losses::int as losses,
            points_for::float8 as points_for
     from public.standings where league_id = $1`,
    [leagueId],
  );
}

/** What the page shows: the rows, put in league_standings_order. */
async function pageOrder(leagueId: string): Promise<string[]> {
  const order = await db.q<{ team_id: string; seed: number }>(
    "select team_id, seed from public.league_standings_order($1)",
    [leagueId],
  );
  const seedByTeam = new Map(order.map((o) => [o.team_id, o.seed]));
  return orderStandings(await standingsRows(leagueId), seedByTeam).map(
    (r) => r.team_id,
  );
}

/** The order the page used before seeding was a setting. */
function oldOrder(rows: Row[]): string[] {
  return [...rows]
    .sort(
      (a, b) =>
        b.wins - a.wins ||
        a.losses - b.losses ||
        Number(b.points_for) - Number(a.points_for),
    )
    .map((r) => r.team_id);
}

describe("the standings page follows the league's seeding", () => {
  test("a league that ranks points against first reads in that order", async () => {
    const f = await makeLeague("standings-pa", 4);
    const t = f.teamIds;
    await threeWayTie(f.leagueId, t);
    await setTiebreakers(f.leagueId, ["points_against"]);

    const shown = await pageOrder(f.leagueId);
    assert.deepEqual(shown, await seedingOrder(f.leagueId));
    assert.deepEqual(shown, [t[3], t[2], t[0], t[1]]);
    assert.notDeepEqual(
      shown,
      oldOrder(await standingsRows(f.leagueId)),
      "the old wins/losses/points-for sort would have shown something else",
    );
  });

  test("the playoff cut sits after playoff_teams rows, on the teams the bracket takes", async () => {
    const f = await makeLeague("standings-cut", 4);
    await threeWayTie(f.leagueId, f.teamIds);
    await setTiebreakers(f.leagueId, ["points_against"]);
    await db.q(
      `update public.leagues
         set playoff_teams = 2, playoff_start_week = 15, current_week = 15
       where id = $1`,
      [f.leagueId],
    );

    const shown = await pageOrder(f.leagueId);
    const above = shown.filter((_, i) => makesPlayoffs(i, 2));
    assert.equal(above.length, 2);
    assert.ok(!makesPlayoffs(2, 2), "the third row is below the line");

    await db.q("select public.generate_playoffs($1)", [f.leagueId]);
    assert.deepEqual(
      above,
      await seedsOf(f.leagueId, "winners"),
      "the rows above the line are the bracket's seeds, in seed order",
    );
  });

  test("an unconfigured league reads exactly as it did", async () => {
    const f = await makeLeague("standings-default", 4);
    await roundRobin(f.leagueId, f.teamIds);

    const shown = await pageOrder(f.leagueId);
    assert.deepEqual(shown, oldOrder(await standingsRows(f.leagueId)));
    assert.deepEqual(shown, f.teamIds);
  });

  test("an unconfigured league with a tied record uses the default, head to head", async () => {
    const f = await makeLeague("standings-default-tie", 4);
    const t = f.teamIds;
    await threeWayTie(f.leagueId, t);

    // Where the records are level the default (head to head, then points
    // for) decides, as it does for the bracket; the old page went
    // straight to points for.
    assert.deepEqual(await pageOrder(f.leagueId), [t[3], t[0], t[1], t[2]]);
    assert.deepEqual(await pageOrder(f.leagueId), await seedingOrder(f.leagueId));
  });

  test("only members get an order", async () => {
    const f = await makeLeague("standings-members", 4);
    await roundRobin(f.leagueId, f.teamIds);

    await db.actAs(f.managers[0]);
    assert.equal(
      (await db.q("select * from public.league_standings_order($1)", [f.leagueId]))
        .length,
      4,
      "a manager in the league sees it",
    );

    const stranger = await db.createUser("stranger-standings@example.com");
    await db.actAs(stranger);
    assert.equal(
      (await db.q("select * from public.league_standings_order($1)", [f.leagueId]))
        .length,
      0,
      "someone outside the league gets nothing",
    );
    await db.actAs(f.commish);
  });

  test("with no order to go on the page falls back to the old sort, not a blank", () => {
    const rows: Row[] = [
      { team_id: "b", wins: 3, losses: 1, points_for: 400 },
      { team_id: "a", wins: 3, losses: 1, points_for: 500 },
      { team_id: "c", wins: 1, losses: 3, points_for: 900 },
    ];
    assert.deepEqual(
      orderStandings(rows, new Map()).map((r) => r.team_id),
      ["a", "b", "c"],
    );
    assert.deepEqual(
      orderStandings(rows, new Map([["c", 1], ["b", 2], ["a", 3]])).map(
        (r) => r.team_id,
      ),
      ["c", "b", "a"],
      "a seed always wins over the fallback",
    );
  });
});

describe("who can call the 0041 functions", () => {
  const MEMBER_FACING = [
    "public.league_standings_order(uuid)",
    "public.playoff_advancers_for(uuid, int)",
  ];
  const INTERNAL = [
    "public.league_seeding_order(uuid)",
    "public.head_to_head_win_pct(uuid, uuid[])",
    "public.seeding_coin_flip(uuid, int, uuid)",
    "public.team_bench_points(uuid, int, uuid, int, int)",
    "public.playoff_tiebreak_key(uuid, int, uuid, int, int, text)",
    "public.bracket_tiebreak(uuid, text)",
    "public.playoff_round_advancers(uuid, int, text, int, boolean)",
  ];

  async function can(role: string, fn: string) {
    return (
      await db.one<{ ok: boolean }>(
        "select has_function_privilege($1, $2, 'execute') as ok",
        [role, fn],
      )
    ).ok;
  }

  test("members' functions are signed-in only; the rest are internal", async () => {
    for (const fn of MEMBER_FACING) {
      assert.equal(await can("anon", fn), false, `anon cannot call ${fn}`);
      assert.equal(await can("authenticated", fn), true, `a user can call ${fn}`);
    }
    for (const fn of INTERNAL) {
      assert.equal(await can("anon", fn), false, `anon cannot call ${fn}`);
      assert.equal(await can("authenticated", fn), false, `a user cannot call ${fn}`);
    }
  });
});

// The settings themselves ----------------------------------------------------

describe("what the save action will accept", () => {
  test("the defaults survive a round trip", () => {
    assert.deepEqual(
      cleanSeedingSettings(DEFAULT_SEEDING_SETTINGS),
      DEFAULT_SEEDING_SETTINGS,
    );
  });

  test("an empty list is a real answer: wins and losses alone", () => {
    const cleaned = cleanSeedingSettings({
      ...DEFAULT_SEEDING_SETTINGS,
      tiebreakers: [],
    });
    assert.deepEqual(cleaned?.tiebreakers, []);
  });

  test("a repeated tiebreaker is kept once, in its first place", () => {
    const cleaned = cleanSeedingSettings({
      ...DEFAULT_SEEDING_SETTINGS,
      tiebreakers: ["points_for", "head_to_head", "points_for"],
    });
    assert.deepEqual(cleaned?.tiebreakers, ["points_for", "head_to_head"]);
  });

  test("anything that is not a choice is refused outright", () => {
    assert.equal(
      cleanSeedingSettings({
        ...DEFAULT_SEEDING_SETTINGS,
        tiebreakers: ["margin" as SeedingTiebreaker],
      }),
      null,
    );
    assert.equal(
      cleanSeedingSettings({
        ...DEFAULT_SEEDING_SETTINGS,
        winnersReseed: "shuffle" as "fixed",
      }),
      null,
    );
    assert.equal(
      cleanSeedingSettings({
        ...DEFAULT_SEEDING_SETTINGS,
        losersTiebreak: "split" as PlayoffTiebreak,
      }),
      null,
      "there is no split: a round has to send exactly one team on",
    );
    assert.equal(cleanSeedingSettings(null), null);
  });
});
