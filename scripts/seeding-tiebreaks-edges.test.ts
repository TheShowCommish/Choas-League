/**
 * T-010 / migration 0041, the corners.
 *
 * scripts/seeding-tiebreaks.test.ts covers the happy paths of each
 * setting. This file is the tester's pass over the cases a league will
 * actually hit and a settings screen cannot warn about: a head-to-head
 * that eats itself, teams that never met, lists at both extremes, byes,
 * a roster that changed after the whistle, and who is allowed to ask
 * the database any of it.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, type TestDb } from "./lib/test-db.ts";
import { SEASON, buildLeague, makePlayer, type Fixture } from "./lib/fixtures.ts";
import {
  DEFAULT_SEEDING_SETTINGS,
  SEEDING_TIEBREAKERS,
  cleanSeedingSettings,
  type SeedingTiebreaker,
} from "../src/lib/playoff-bracket.ts";

let db: TestDb;

before(async () => {
  db = await createTestDb();
});

after(async () => {
  await db.close();
});

// Helpers --------------------------------------------------------------------

async function makeLeague(
  name: string,
  size: number,
): Promise<Fixture & { teamIds: string[] }> {
  const f = await buildLeague(db, name);
  await db.actAs(f.commish);
  await db.q("select public.set_team_count($1, $2)", [f.leagueId, size]);

  const code = await db.one<{ join_code: string }>(
    "select join_code from public.leagues where id = $1",
    [f.leagueId],
  );
  for (let i = f.teamIds.length; i < size; i++) {
    const uid = await db.createUser(`edge${i}-${name}@example.com`);
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

/**
 * One regular season game in `week`. Only (league, season, week, home)
 * is unique, so a week can hold several games as long as the home teams
 * differ -- which keeps every fixture inside weeks 1..14 and well clear
 * of the playoff weeks.
 */
async function playGame(
  leagueId: string,
  week: number,
  home: string,
  away: string,
  homeScore: number,
  awayScore: number,
  opts: { playoff?: boolean; status?: string } = {},
) {
  await db.q(
    `insert into public.matchups
       (league_id, season, week, home_team_id, away_team_id,
        home_score, away_score, status, is_playoff)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      leagueId,
      SEASON,
      week,
      home,
      away,
      homeScore,
      awayScore,
      opts.status ?? "final",
      opts.playoff ?? false,
    ],
  );
}

/**
 * Team i beats every team after it, 100-50, so the table reads in the
 * order of `teamIds`. Game (i, j) is played in week j: the home teams
 * inside a week are all different, and the last week is teams - 1.
 */
async function roundRobin(leagueId: string, teamIds: string[]) {
  for (let i = 0; i < teamIds.length; i++) {
    for (let j = i + 1; j < teamIds.length; j++) {
      await playGame(leagueId, j, teamIds[i], teamIds[j], 100, 50);
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

async function h2h(leagueId: string, teams: string[]) {
  const rows = await db.q<{ team_id: string; win_pct: string }>(
    "select team_id, win_pct from public.head_to_head_win_pct($1, $2)",
    [leagueId, teams],
  );
  return new Map(rows.map((r) => [r.team_id, Number(r.win_pct)]));
}

interface Game {
  id: string;
  week: number;
  bracket_slot: number | null;
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
    `select id, week, bracket_slot, home_team_id, away_team_id, status
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

async function advancers(leagueId: string): Promise<Map<string, string>> {
  const rows = await db.q<{ matchup_id: string; team_id: string }>(
    "select matchup_id, team_id from public.playoff_advancers_for($1, $2)",
    [leagueId, SEASON],
  );
  return new Map(rows.map((r) => [r.matchup_id, r.team_id]));
}

/** A rostered player with points, on the bench unless `slotKey` starts. */
async function benchPoints(
  leagueId: string,
  teamId: string,
  week: number,
  points: number,
  tag = "x",
): Promise<string> {
  const playerId = await makePlayer(
    db,
    `edge-bench-${teamId}-${week}-${tag}`,
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
  await db.q(
    `insert into public.lineup_entries
       (league_id, team_id, season, week, player_id, slot_key)
     values ($1, $2, $3, $4, $5, 'BN')`,
    [leagueId, teamId, SEASON, week, playerId],
  );
  return playerId;
}

// Head to head ---------------------------------------------------------------

describe("head to head when it cannot answer", () => {
  /**
   * A, B and C in a circle: A beat B, B beat C, C beat A. Every team is
   * 1-1 inside the tie, so head to head separates nobody and the next
   * tiebreaker has to take over. This is the case a league will hit
   * every year and the one an "A is above B" implementation gets wrong.
   */
  let leagueId: string;
  let t: string[];

  before(async () => {
    const f = await makeLeague("edge-circular", 4);
    leagueId = f.leagueId;
    t = f.teamIds;

    await playGame(leagueId, 1, t[0], t[1], 100, 90); // A beat B
    await playGame(leagueId, 2, t[1], t[2], 100, 95); // B beat C
    await playGame(leagueId, 3, t[2], t[0], 100, 80); // C beat A
  });

  test("a circular three-way tie leaves all three level", async () => {
    const pct = await h2h(leagueId, [t[0], t[1], t[2]]);
    assert.deepEqual(
      [pct.get(t[0]), pct.get(t[1]), pct.get(t[2])].map((v) =>
        Number(v!.toFixed(4)),
      ),
      [0.5, 0.5, 0.5],
      "1-1 inside the tie is 0.5 for each of them",
    );
  });

  test("so the next tiebreaker decides, and the circle changes nothing", async () => {
    // PF: A 180, B 190, C 195. Points for alone gives C, B, A.
    const pf = await db.q<{ team_id: string; points_for: string }>(
      "select team_id, points_for from public.standings where league_id = $1",
      [leagueId],
    );
    const by = new Map(pf.map((r) => [r.team_id, Number(r.points_for)]));
    assert.deepEqual(
      [by.get(t[0]), by.get(t[1]), by.get(t[2])],
      [180, 190, 195],
    );

    await setTiebreakers(leagueId, ["head_to_head", "points_for"]);
    const withH2h = await seedingOrder(leagueId);
    await setTiebreakers(leagueId, ["points_for"]);
    const withoutH2h = await seedingOrder(leagueId);

    assert.deepEqual(withH2h, [t[2], t[1], t[0], t[3]]);
    assert.deepEqual(
      withH2h,
      withoutH2h,
      "a circular head to head is a no-op, not a coin toss",
    );
  });

  test("head to head with nothing after it still produces a stable order", async () => {
    await setTiebreakers(leagueId, ["head_to_head"]);
    const first = await seedingOrder(leagueId);
    const second = await seedingOrder(leagueId);
    assert.deepEqual(first, second, "asking twice gives the same answer");
    assert.deepEqual([...first].sort(), [...t].sort(), "everyone is seeded");
  });

  test("head to head counts only finished regular season games", async () => {
    // A playoff meeting and an unfinished game must not move the pct.
    const before = await h2h(leagueId, [t[0], t[1]]);
    await playGame(leagueId, 4, t[1], t[0], 200, 0, { playoff: true });
    await playGame(leagueId, 5, t[1], t[0], 200, 0, { status: "in_progress" });
    assert.deepEqual(await h2h(leagueId, [t[0], t[1]]), before);
  });
});

describe("two teams that never played each other", () => {
  /**
   * Four teams, two weeks, no rematches: T0 and T1 both finish 1-0 and
   * have never met. With head_to_head first they come back level, so
   * whatever is second is the only thing deciding -- and swapping it
   * has to swap the seeds.
   */
  let leagueId: string;
  let t: string[];

  before(async () => {
    const f = await makeLeague("edge-never-met", 4);
    leagueId = f.leagueId;
    t = f.teamIds;
    await playGame(leagueId, 1, t[0], t[2], 120, 50);
    await playGame(leagueId, 1, t[1], t[3], 110, 100);
  });

  test("they come back level rather than one of them winning by default", async () => {
    const pct = await h2h(leagueId, [t[0], t[1]]);
    assert.deepEqual([pct.get(t[0]), pct.get(t[1])], [0.5, 0.5]);
  });

  test("head to head first, and the second tiebreaker is what decides", async () => {
    await setTiebreakers(leagueId, ["head_to_head", "points_for"]);
    assert.deepEqual(
      (await seedingOrder(leagueId)).slice(0, 2),
      [t[0], t[1]],
      "120 points for beats 110",
    );

    await setTiebreakers(leagueId, ["head_to_head", "points_against"]);
    assert.deepEqual(
      (await seedingOrder(leagueId)).slice(0, 2),
      [t[1], t[0]],
      "100 points against beats 50; the pair is decided by key two",
    );
  });
});

// The list itself ------------------------------------------------------------

describe("the ends of the tiebreaker list", () => {
  let leagueId: string;
  let t: string[];

  before(async () => {
    const f = await makeLeague("edge-list-ends", 4);
    leagueId = f.leagueId;
    t = f.teamIds;
    // Everyone 0-0 and level on everything: only the list can separate
    // them, so an empty list has to fall through to the fixed order.
  });

  test("an empty list seeds everyone and repeats itself exactly", async () => {
    await setTiebreakers(leagueId, []);
    const first = await seedingOrder(leagueId);
    const second = await seedingOrder(leagueId);
    assert.equal(first.length, 4);
    assert.deepEqual([...first].sort(), [...t].sort());
    assert.deepEqual(first, second, "the fallback order is fixed, not random");
    assert.deepEqual(
      first,
      [...t].sort(),
      "the documented fallback is the team id",
    );
  });

  test("every option at once is legal and still a total order", async () => {
    await setTiebreakers(leagueId, SEEDING_TIEBREAKERS);
    const saved = await db.one<{ seeding_tiebreakers: string[] }>(
      "select seeding_tiebreakers from public.leagues where id = $1",
      [leagueId],
    );
    assert.deepEqual(saved.seeding_tiebreakers, SEEDING_TIEBREAKERS);

    const order = await seedingOrder(leagueId);
    assert.equal(new Set(order).size, 4, "no team is seeded twice");
    assert.deepEqual(order, await seedingOrder(leagueId));
  });

  test("a hand-written duplicate in the column does not break seeding", async () => {
    // The save action de-duplicates, but the check constraint only asks
    // that the values are known -- so SQL can still put one in twice.
    await setTiebreakers(leagueId, [
      "points_for",
      "points_for",
      "head_to_head",
    ]);
    const order = await seedingOrder(leagueId);
    assert.equal(new Set(order).size, 4);
  });

  test("a null list falls back to the documented default", async () => {
    // The column is not null, so this can only be reached by dropping
    // the constraint -- which is what an older row would look like.
    await db.exec(
      `alter table public.leagues alter column seeding_tiebreakers drop not null`,
    );
    await db.q(
      "update public.leagues set seeding_tiebreakers = null where id = $1",
      [leagueId],
    );
    const order = await seedingOrder(leagueId);
    assert.equal(order.length, 4, "it seeds rather than returning nothing");
    await db.q(
      "update public.leagues set seeding_tiebreakers = $2 where id = $1",
      [leagueId, DEFAULT_SEEDING_SETTINGS.tiebreakers],
    );
    await db.exec(
      `alter table public.leagues alter column seeding_tiebreakers set not null`,
    );
  });
});

// Coin flip ------------------------------------------------------------------

describe("the coin flip is a coin that remembers", () => {
  test("two leagues with the same team names do not get the same flip", async () => {
    const a = await makeLeague("edge-coin-a", 4);
    const b = await makeLeague("edge-coin-b", 4);

    // Same names on both sides, so only the ids differ.
    for (const [league, teams] of [
      [a.leagueId, a.teamIds],
      [b.leagueId, b.teamIds],
    ] as [string, string[]][]) {
      for (let i = 0; i < teams.length; i++) {
        await db.q("update public.teams set name = $2 where id = $1", [
          teams[i],
          `Clone ${i}`,
        ]);
      }
      await setTiebreakers(league, ["coin_flip"]);
    }

    const sameTeam = "33333333-3333-3333-3333-333333333333";
    const flipA = await db.one<{ f: string }>(
      "select public.seeding_coin_flip($1, $2, $3)::text as f",
      [a.leagueId, SEASON, sameTeam],
    );
    const flipB = await db.one<{ f: string }>(
      "select public.seeding_coin_flip($1, $2, $3)::text as f",
      [b.leagueId, SEASON, sameTeam],
    );
    assert.notEqual(
      flipA.f,
      flipB.f,
      "the league is part of the flip, so identical leagues flip differently",
    );

    const nextSeason = await db.one<{ f: string }>(
      "select public.seeding_coin_flip($1, $2, $3)::text as f",
      [a.leagueId, SEASON + 1, sameTeam],
    );
    assert.notEqual(flipA.f, nextSeason.f, "a new season re-flips");
  });

  test("regenerating the bracket seeds it identically", async () => {
    const f = await makeLeague("edge-coin-regen", 4);
    await setTiebreakers(f.leagueId, ["coin_flip"]);
    await db.q(
      `update public.leagues
         set playoff_teams = 4, playoff_start_week = 15, current_week = 15
       where id = $1`,
      [f.leagueId],
    );

    await db.q("select public.generate_playoffs($1)", [f.leagueId]);
    const first = await seedsOf(f.leagueId, "winners");
    await db.q("select public.generate_playoffs($1)", [f.leagueId]);
    const second = await seedsOf(f.leagueId, "winners");

    assert.equal(first.length, 4);
    assert.deepEqual(
      first,
      second,
      "a regenerated bracket is the same bracket",
    );
  });
});

// Byes -----------------------------------------------------------------------

describe("a bye round", () => {
  /**
   * Six teams into an eight-team draw is two byes: two round-one games
   * with no away side. Nothing about them is a tie, but the advancer
   * has to carry them anyway, and the bracket screen has to tag them.
   */
  test("the bye team goes through whatever the tiebreak is set to", async () => {
    const f = await makeLeague("edge-bye", 6);
    await roundRobin(f.leagueId, f.teamIds);
    await db.q(
      `update public.leagues
         set playoff_teams = 6, playoff_start_week = 15, current_week = 15,
             playoff_tiebreak = 'bench_points'
       where id = $1`,
      [f.leagueId],
    );
    await db.q("select public.generate_playoffs($1)", [f.leagueId]);

    const seeds = await seedsOf(f.leagueId, "winners");
    assert.deepEqual(seeds, f.teamIds, "six teams seeded in order");

    const round1 = await playoffGames(f.leagueId, "winners", 15);
    const byes = round1.filter((g) => g.away_team_id === null);
    assert.equal(byes.length, 2, "seeds 1 and 2 sit out");
    assert.deepEqual(
      byes.map((g) => g.home_team_id).sort(),
      [seeds[0], seeds[1]].sort(),
    );

    await finish(f.leagueId, "winners", 15);

    const tags = await advancers(f.leagueId);
    for (const bye of byes) {
      assert.equal(
        tags.get(bye.id),
        bye.home_team_id,
        "a bye advances its own team, with no away side to compare",
      );
    }

    const carried = await db.q<{ team_id: string }>(
      `select team_id from public.playoff_round_advancers($1, $2, 'winners', 15, false)`,
      [f.leagueId, SEASON],
    );
    assert.equal(carried.length, 4);
    assert.ok(
      carried.some((r) => r.team_id === seeds[0]),
      "the bye team is in the next round",
    );
  });

  test("a bye scored 0-0 is not read as a tie", async () => {
    // 0-0 with no away side is exactly what an unplayed bye looks like;
    // the seed comparison must never get a look in.
    const row = await db.one<{ who: string | null }>(
      `select public.playoff_game_advancer(
         '11111111-1111-1111-1111-111111111111'::uuid, null,
         0, 0, true, 'points_for', 0, 9999, 9, 1) as who`,
    );
    assert.equal(row.who, "11111111-1111-1111-1111-111111111111");
  });
});

// Bench points and a roster that moved ---------------------------------------

describe("bench points read the roster as it is now", () => {
  /**
   * The reviewer's flag, pinned. team_bench_points joins roster_players
   * with dropped_at is null, which is deliberately the same set the
   * matchup screen prints -- but it means a tie already settled can be
   * re-settled the other way by a waiver move, and the bracket screen's
   * "Advances" tag can then disagree with a round that has already been
   * drawn.
   */
  test("dropping the bench player after the game changes who the tag says goes through", async () => {
    const f = await makeLeague("edge-bench-drop", 4);
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

    await benchPoints(f.leagueId, seeds[0], 15, 5, "top");
    const dropped = await benchPoints(f.leagueId, seeds[3], 15, 30, "bottom");

    await finish(f.leagueId, "winners", 15, (g) =>
      g.home_team_id === seeds[0] ? [100, 100] : [100, 50],
    );
    const tied = (await playoffGames(f.leagueId, "winners", 15)).find(
      (g) => g.home_team_id === seeds[0],
    )!;

    assert.equal(
      (await advancers(f.leagueId)).get(tied.id),
      seeds[3],
      "30 on the bench beats 5",
    );

    // The round is drawn while that is still true.
    await db.q("select public.advance_playoffs($1, 15)", [f.leagueId]);
    const final = (await playoffGames(f.leagueId, "winners", 16))[0];
    assert.ok(
      [final.home_team_id, final.away_team_id].includes(seeds[3]),
      "the bracket carried seed 4 into the final",
    );

    // Now the bench player is dropped, a week later.
    await db.q(
      `update public.roster_players set dropped_at = now()
       where league_id = $1 and team_id = $2 and player_id = $3`,
      [f.leagueId, seeds[3], dropped],
    );

    assert.equal(
      await db
        .one<{ p: string }>(
          "select public.team_bench_points($1, $2, $3, 15, 1) as p",
          [f.leagueId, SEASON, seeds[3]],
        )
        .then((r) => Number(r.p)),
      0,
      "a dropped player takes his bench points with him",
    );

    assert.equal(
      (await advancers(f.leagueId)).get(tied.id),
      seeds[0],
      "KNOWN: the bracket screen's Advances tag now names the team that " +
        "did NOT advance, because the tie is recomputed from today's roster",
    );
  });
});

// Points for, with nothing between the two -----------------------------------

describe("points for when both seasons are identical", () => {
  test("it falls back to the seed rather than to the home side", async () => {
    const f = await makeLeague("edge-pf-identical", 4);
    const t = f.teamIds;
    // Records 3-0, 2-1, 1-2, 0-3, but the two teams that miss the
    // playoffs -- T2 and T3 -- are steered to exactly 200 points for,
    // so points_for has nothing to say about their game.
    await playGame(f.leagueId, 1, t[0], t[1], 100, 50);
    await playGame(f.leagueId, 2, t[0], t[2], 100, 50);
    await playGame(f.leagueId, 3, t[0], t[3], 100, 60);
    await playGame(f.leagueId, 2, t[1], t[2], 100, 60);
    await playGame(f.leagueId, 3, t[1], t[3], 100, 60);
    await playGame(f.leagueId, 4, t[2], t[3], 90, 80);
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

    const losers = await seedsOf(f.leagueId, "losers");
    assert.equal(losers.length, 2);

    const pf = await db.q<{ team_id: string; points_for: string }>(
      "select team_id, points_for from public.standings where league_id = $1",
      [f.leagueId],
    );
    const by = new Map(pf.map((r) => [r.team_id, Number(r.points_for)]));
    assert.equal(
      by.get(losers[0]),
      by.get(losers[1]),
      "the two entrants scored exactly the same over the season",
    );

    await finish(f.leagueId, "losers", 15, () => [100, 100]);
    const game = (await playoffGames(f.leagueId, "losers", 15))[0];
    assert.equal(
      (await advancers(f.leagueId)).get(game.id),
      losers[0],
      "level on the tiebreak too, so the toilet bowl's top seed sinks",
    );
  });
});

// Who may ask ----------------------------------------------------------------

describe("the new functions are not readable by outsiders", () => {
  test("only the two members-only readers are granted, and only to authenticated", async () => {
    // playoff_advancers_for (bracket tags) and league_standings_order
    // (standings order) are the only entry points; each gates on
    // is_league_member itself. Everything else is internal.
    const checks: [string, boolean][] = [
      ["public.playoff_advancers_for(uuid, int)", true],
      ["public.league_standings_order(uuid)", true],
      ["public.league_seeding_order(uuid)", false],
      ["public.head_to_head_win_pct(uuid, uuid[])", false],
      ["public.seeding_coin_flip(uuid, int, uuid)", false],
      ["public.team_bench_points(uuid, int, uuid, int, int)", false],
      ["public.playoff_tiebreak_key(uuid, int, uuid, int, int, text)", false],
      ["public.bracket_tiebreak(uuid, text)", false],
      ["public.playoff_round_advancers(uuid, int, text, int, boolean)", false],
    ];

    for (const [signature, authed] of checks) {
      const row = await db.one<{ a: boolean; anon: boolean }>(
        `select has_function_privilege('authenticated', $1, 'execute') as a,
                has_function_privilege('anon', $1, 'execute') as anon`,
        [signature],
      );
      assert.equal(row.a, authed, `${signature} for authenticated`);
      assert.equal(row.anon, false, `${signature} must never be anon's`);
    }
  });
});

describe("under enforced row level security", () => {
  let rls: TestDb;
  let leagueId: string;
  let commish: string;
  let member: string;
  let outsider: string;
  let matchupIds: string[];

  before(async () => {
    rls = await createTestDb({ enforceRls: true });

    commish = await rls.createUser("edge-commish@example.com", "Commish");
    member = await rls.createUser("edge-member@example.com", "Member");
    outsider = await rls.createUser("edge-outsider@example.com", "Outsider");

    await rls.actAs(commish);
    const league = await rls.one<{ id: string; join_code: string }>(
      `insert into public.leagues (name, season, commissioner_id, team_count)
       values ('Edge League', $1, $2, 2) returning id, join_code`,
      [SEASON, commish],
    );
    leagueId = league.id;
    await rls.one("select public.join_league($1, $2) as t", [
      league.join_code,
      "Commish FC",
    ]);
    await rls.actAs(member);
    await rls.one("select public.join_league($1, $2) as t", [
      league.join_code,
      "Member FC",
    ]);

    // A finished regular season and a generated bracket.
    await rls.asSuperuser(async () => {
      const teams = await rls.q<{ id: string }>(
        "select id from public.teams where league_id = $1 order by created_at, id",
        [leagueId],
      );
      await rls.q(
        `insert into public.matchups
           (league_id, season, week, home_team_id, away_team_id,
            home_score, away_score, status, is_playoff)
         values ($1, $2, 1, $3, $4, 100, 50, 'final', false)`,
        [leagueId, SEASON, teams[0].id, teams[1].id],
      );
      await rls.q(
        `update public.leagues
           set playoff_teams = 2, playoff_start_week = 15, current_week = 15
         where id = $1`,
        [leagueId],
      );
    });

    await rls.actAs(commish);
    await rls.q("select public.generate_playoffs($1)", [leagueId]);
    await rls.asSuperuser(async () => {
      await rls.q(
        `update public.matchups
           set home_score = 100, away_score = 100, status = 'final'
         where league_id = $1 and is_playoff`,
        [leagueId],
      );
      const rows = await rls.q<{ id: string }>(
        "select id from public.matchups where league_id = $1 and is_playoff",
        [leagueId],
      );
      matchupIds = rows.map((r) => r.id);
    });
    assert.ok(matchupIds.length > 0);
  });

  after(async () => {
    await rls.close();
  });

  test("a member reads the advancers", async () => {
    await rls.actAs(member);
    const rows = await rls.q(
      "select matchup_id, team_id from public.playoff_advancers_for($1, $2)",
      [leagueId, SEASON],
    );
    assert.equal(rows.length, matchupIds.length);
  });

  test("a non-member reads nothing at all (Q11: league data is members-only)", async () => {
    await rls.actAs(outsider);
    const rows = await rls.q(
      "select matchup_id, team_id from public.playoff_advancers_for($1, $2)",
      [leagueId, SEASON],
    );
    assert.deepEqual(rows, [], "not one row of another league's playoffs");
  });

  test("a signed-out caller reads nothing either", async () => {
    await rls.actAs(null);
    const rows = await rls.q(
      "select matchup_id, team_id from public.playoff_advancers_for($1, $2)",
      [leagueId, SEASON],
    );
    assert.deepEqual(rows, []);
  });

  test("the standings order is members-only too", async () => {
    await rls.actAs(member);
    const mine = await rls.q<{ team_id: string; seed: number }>(
      "select team_id, seed from public.league_standings_order($1)",
      [leagueId],
    );
    assert.equal(mine.length, 2, "a member sees every team's place");

    await rls.actAs(outsider);
    assert.deepEqual(
      await rls.q("select * from public.league_standings_order($1)", [leagueId]),
      [],
      "a non-member learns nothing about another league",
    );

    await rls.actAs(null);
    assert.deepEqual(
      await rls.q("select * from public.league_standings_order($1)", [leagueId]),
      [],
    );
  });

  test("a plain member cannot change the seeding settings", async () => {
    await rls.actAs(member);
    const before = await rls.asSuperuser(() =>
      rls.one<{ seeding_tiebreakers: string[] }>(
        "select seeding_tiebreakers from public.leagues where id = $1",
        [leagueId],
      ),
    );

    await rls.q(
      `update public.leagues set seeding_tiebreakers = array['coin_flip']::text[],
              playoff_tiebreak = 'bench_points'
       where id = $1`,
      [leagueId],
    );

    const after = await rls.asSuperuser(() =>
      rls.one<{ seeding_tiebreakers: string[]; playoff_tiebreak: string }>(
        `select seeding_tiebreakers, playoff_tiebreak
         from public.leagues where id = $1`,
        [leagueId],
      ),
    );
    assert.deepEqual(
      after.seeding_tiebreakers,
      before.seeding_tiebreakers,
      "the row is not the member's to write",
    );
    assert.equal(after.playoff_tiebreak, "higher_seed");
  });

  test("a non-commissioner cannot generate or advance the playoffs", async () => {
    await rls.actAs(member);
    await assert.rejects(
      () => rls.q("select public.generate_playoffs($1)", [leagueId]),
      /commissioner/i,
    );
    await assert.rejects(
      () => rls.q("select public.advance_playoffs($1, 15)", [leagueId]),
      /commissioner/i,
    );
  });

  test("an outsider cannot generate another league's playoffs", async () => {
    await rls.actAs(outsider);
    await assert.rejects(
      () => rls.q("select public.generate_playoffs($1)", [leagueId]),
      /commissioner/i,
    );
  });
});

// What the save action lets through ------------------------------------------

describe("hand-crafted settings through the server action's gate", () => {
  test("a missing list is treated as empty, not as a crash", () => {
    const cleaned = cleanSeedingSettings({
      ...DEFAULT_SEEDING_SETTINGS,
      tiebreakers: undefined as unknown as SeedingTiebreaker[],
    });
    assert.deepEqual(cleaned?.tiebreakers, []);
  });

  test("one bad entry rejects the whole list, not just itself", () => {
    assert.equal(
      cleanSeedingSettings({
        ...DEFAULT_SEEDING_SETTINGS,
        tiebreakers: [
          "points_for",
          "sos" as SeedingTiebreaker,
          "head_to_head",
        ],
      }),
      null,
      "a request that smuggles one unknown key saves nothing",
    );
  });

  test("case and whitespace are not quietly accepted", () => {
    for (const bad of ["Points_For", " points_for", "points_for "]) {
      assert.equal(
        cleanSeedingSettings({
          ...DEFAULT_SEEDING_SETTINGS,
          tiebreakers: [bad as SeedingTiebreaker],
        }),
        null,
        bad,
      );
    }
  });

  test("a prototype key is not mistaken for a tiebreaker", () => {
    for (const bad of ["constructor", "__proto__", "toString"]) {
      assert.equal(
        cleanSeedingSettings({
          ...DEFAULT_SEEDING_SETTINGS,
          tiebreakers: [bad as SeedingTiebreaker],
        }),
        null,
        bad,
      );
    }
  });

  test("the bracket choices are checked as well as the list", () => {
    assert.equal(
      cleanSeedingSettings({
        ...DEFAULT_SEEDING_SETTINGS,
        winnersTiebreak: "bench" as never,
      }),
      null,
    );
    assert.equal(
      cleanSeedingSettings({
        ...DEFAULT_SEEDING_SETTINGS,
        winnersReseed: undefined as never,
      }),
      null,
    );
    assert.equal(
      cleanSeedingSettings({
        ...DEFAULT_SEEDING_SETTINGS,
        losersTiebreak: null as never,
      }),
      null,
    );
  });

  test("nothing but the four known fields survives", () => {
    const cleaned = cleanSeedingSettings({
      ...DEFAULT_SEEDING_SETTINGS,
      leagueId: "somebody else's",
      status: "complete",
    } as never);
    assert.deepEqual(Object.keys(cleaned ?? {}).sort(), [
      "losersTiebreak",
      "tiebreakers",
      "winnersReseed",
      "winnersTiebreak",
    ]);
  });

  test("every value the UI can produce is accepted", () => {
    for (const key of SEEDING_TIEBREAKERS) {
      assert.deepEqual(
        cleanSeedingSettings({
          ...DEFAULT_SEEDING_SETTINGS,
          tiebreakers: [key],
        })?.tiebreakers,
        [key],
        key,
      );
    }
  });
});

// The standings page -----------------------------------------------------------

describe("the standings page follows the seeding order", () => {
  test("the order and the playoff line are the seeds generate_playoffs uses", async () => {
    const { orderStandings, makesPlayoffs } = await import(
      "../src/lib/standings-order.ts"
    );
    const f = await makeLeague("edge-standings-order", 4);
    const t = f.teamIds;
    // T0 3-0; T1, T2 and T3 cannot all be separated by record, so the
    // league's list decides, and points_against disagrees with the old
    // hard-coded points_for sort.
    await playGame(f.leagueId, 1, t[0], t[1], 100, 50);
    await playGame(f.leagueId, 2, t[0], t[2], 100, 50);
    await playGame(f.leagueId, 3, t[0], t[3], 100, 50);
    await playGame(f.leagueId, 1, t[1], t[2], 120, 110); // T1 beat T2
    await playGame(f.leagueId, 2, t[3], t[1], 90, 80); // T3 beat T1
    await playGame(f.leagueId, 3, t[2], t[3], 95, 60); // T2 beat T3
    await setTiebreakers(f.leagueId, ["points_against"]);

    // Cast like the page does: numeric comes back from the driver as text.
    const rows = (
      await db.q<{
        team_id: string;
        wins: number;
        losses: number;
        points_for: string;
      }>(
        "select team_id, wins, losses, points_for from public.standings where league_id = $1",
        [f.leagueId],
      )
    ).map((r) => ({ ...r, points_for: Number(r.points_for) }));
    const seeds = await db.q<{ team_id: string; seed: number }>(
      "select team_id, seed from public.league_standings_order($1)",
      [f.leagueId],
    );
    // Acting as the commissioner, a member, so the members-only RPC answers.
    assert.equal(seeds.length, 4);

    const ordered = orderStandings(
      rows,
      new Map(seeds.map((s) => [s.team_id, s.seed])),
    );
    assert.deepEqual(
      ordered.map((r) => r.team_id),
      await seedingOrder(f.leagueId),
      "the table reads in seed order",
    );

    await db.q(
      `update public.leagues
         set playoff_teams = 2, playoff_start_week = 15, current_week = 15
       where id = $1`,
      [f.leagueId],
    );
    await db.q("select public.generate_playoffs($1)", [f.leagueId]);
    const inBracket = new Set(
      (
        await db.q<{ team_id: string }>(
          "select team_id from public.playoff_seeds where league_id = $1 and bracket = 'winners'",
          [f.leagueId],
        )
      ).map((r) => r.team_id),
    );
    ordered.forEach((row, i) =>
      assert.equal(
        makesPlayoffs(i, 2),
        inBracket.has(row.team_id),
        `row ${i + 1}: the cut line and the bracket agree`,
      ),
    );
  });

  test("with no RPC answer it falls back to the old sort, not a blank page", async () => {
    const { orderStandings } = await import("../src/lib/standings-order.ts");
    const rows = [
      { team_id: "b", wins: 5, losses: 3, points_for: 900 },
      { team_id: "a", wins: 5, losses: 3, points_for: 900 },
      { team_id: "c", wins: 6, losses: 2, points_for: 800 },
      { team_id: "d", wins: 5, losses: 3, points_for: 950 },
    ];
    assert.deepEqual(
      orderStandings(rows, new Map()).map((r) => r.team_id),
      ["c", "d", "a", "b"],
    );
  });
});

describe("the standings caption", () => {
  test("names the list the way seeding reads it", async () => {
    const { seedingTiebreakCaption } = await import(
      "../src/app/l/[leagueId]/seeding-copy.ts"
    );
    assert.equal(
      seedingTiebreakCaption(DEFAULT_SEEDING_SETTINGS.tiebreakers),
      "Ties broken by head-to-head, then points for.",
    );
    assert.equal(seedingTiebreakCaption([]), "Ties broken by a fixed order.");
    assert.equal(
      seedingTiebreakCaption(["division_record"]),
      "Ties broken by a fixed order.",
      "an idle division record is not promised",
    );
    assert.equal(
      seedingTiebreakCaption(SEEDING_TIEBREAKERS),
      "Ties broken by head-to-head, then points for, then points against, then a coin flip.",
    );
    assert.equal(
      seedingTiebreakCaption(["coin_flip", "points_for"]),
      "Ties broken by a coin flip.",
      "nothing after a coin flip is ever reached",
    );
  });
});
