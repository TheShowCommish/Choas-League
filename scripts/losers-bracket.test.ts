/**
 * The losers bracket: its own settings, its own rounds, and the league
 * waiting for it before calling the season over.
 *
 * Every scenario is also played on paper through src/lib/playoff-bracket
 * .ts, which is what the admin preview and the save validation use, and
 * the two are compared round by round. If the preview and the database
 * ever disagree about a week, a field size or a bye, a test here fails.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  applyMigration,
  createBareDb,
  createTestDb,
  migrationFiles,
  type TestDb,
} from "./lib/test-db.ts";
import { SEASON, buildLeague } from "./lib/fixtures.ts";
import {
  losersEntrantCount,
  losersShape,
  roundSpans,
  settleByes,
  validateLosersBracket,
  winnersShape,
  type LosersSettings,
  type RoundConfig,
  type RoundShape,
} from "../src/lib/playoff-bracket.ts";

let db: TestDb;

before(async () => {
  db = await createTestDb();
});

after(async () => {
  await db.close();
});

type Bracket = "winners" | "losers";

interface Round extends Partial<RoundConfig> {
  weeks?: number;
}

interface Scenario {
  name: string;
  teams: number;
  playoffTeams: number;
  playoffStartWeek: number;
  winners: Round[];
  losers: Round[];
  settings: LosersSettings;
}

function full(rounds: Round[]): RoundConfig[] {
  return rounds.map((r) => ({
    name: r.name ?? "",
    weeks: r.weeks ?? 1,
    teams: r.teams ?? null,
    byes: r.byes ?? 0,
  }));
}

/**
 * A league of `teams` teams with a distinct regular season record each,
 * its playoffs and losers bracket configured, and the bracket generated.
 */
async function setup(s: Scenario) {
  const f = await buildLeague(db, s.name);
  await db.q("select public.set_team_count($1, $2)", [f.leagueId, s.teams]);

  const teamIds = (
    await db.q<{ id: string }>(
      "select id from public.teams where league_id = $1 order by created_at, id",
      [f.leagueId],
    )
  ).map((t) => t.id);
  assert.equal(teamIds.length, s.teams);

  // Team i beats every team after it, so the standings are exactly the
  // order of teamIds. Played last season, so the weeks never collide with
  // this season's playoff games.
  let week = 1;
  for (let i = 0; i < teamIds.length; i++) {
    for (let j = i + 1; j < teamIds.length; j++) {
      await db.q(
        `insert into public.matchups
           (league_id, season, week, home_team_id, away_team_id,
            home_score, away_score, status, is_playoff)
         values ($1, $2, $3, $4, $5, 100, 50, 'final', false)`,
        [f.leagueId, SEASON - 1, week++, teamIds[i], teamIds[j]],
      );
    }
  }

  await db.q(
    `update public.leagues
       set playoff_teams = $2, playoff_start_week = $3, current_week = $3,
           losers_bracket_enabled = $4, losers_entrants = $5,
           losers_mode = $6, losers_reseed = $7, losers_start_week = $8
     where id = $1`,
    [
      f.leagueId,
      s.playoffTeams,
      s.playoffStartWeek,
      s.settings.enabled,
      s.settings.entrants,
      s.settings.mode,
      s.settings.reseed,
      s.settings.startWeek,
    ],
  );

  for (const [bracket, rounds] of [
    ["winners", s.winners],
    ["losers", s.losers],
  ] as const) {
    const cfg = full(rounds);
    for (let i = 0; i < cfg.length; i++) {
      await db.q(
        `insert into public.league_playoff_rounds
           (league_id, bracket, round_index, name, weeks, teams, byes)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [f.leagueId, bracket, i + 1, cfg[i].name, cfg[i].weeks, cfg[i].teams, cfg[i].byes],
      );
    }
  }

  await db.q("select public.generate_playoffs($1)", [f.leagueId]);
  return { ...f, standings: teamIds };
}

interface Game {
  id: string;
  week: number;
  week_count: number;
  home_team_id: string;
  away_team_id: string | null;
  playoff_round: string;
  status: string;
}

async function games(leagueId: string, bracket: Bracket, week?: number) {
  return db.q<Game>(
    `select id, week, week_count, home_team_id, away_team_id, playoff_round, status
     from public.matchups
     where league_id = $1 and is_playoff and bracket = $2
       and ($3::int is null or week = $3)
     order by week, home_team_id`,
    [leagueId, bracket, week ?? null],
  );
}

async function seedsOf(leagueId: string, bracket: Bracket) {
  const rows = await db.q<{ team_id: string; seed: number }>(
    `select team_id, seed from public.playoff_seeds
     where league_id = $1 and bracket = $2 order by seed`,
    [leagueId, bracket],
  );
  return rows.map((r) => r.team_id);
}

/**
 * Finishes every open game starting in `week` in `bracket`. The home
 * side wins unless the away team is in `awayWins`.
 */
async function finish(
  leagueId: string,
  bracket: Bracket,
  week: number,
  awayWins: string[] = [],
) {
  for (const g of await games(leagueId, bracket, week)) {
    if (g.status === "final") continue;
    const away = g.away_team_id !== null && awayWins.includes(g.away_team_id);
    await db.q(
      `update public.matchups
         set home_score = $2, away_score = $3, status = 'final'
       where id = $1`,
      [g.id, away ? 50 : 100, away ? 100 : 50],
    );
  }
}

async function advance(leagueId: string, week: number) {
  return (
    await db.one<{ n: number }>(
      "select public.advance_playoffs($1, $2) as n",
      [leagueId, week],
    )
  ).n;
}

async function status(leagueId: string) {
  return (
    await db.one<{ status: string }>(
      "select status from public.leagues where id = $1",
      [leagueId],
    )
  ).status;
}

/** The bracket as the database built it, in the preview's terms. */
async function dbShape(leagueId: string, bracket: Bracket) {
  const byWeek = new Map<number, Game[]>();
  for (const g of await games(leagueId, bracket)) {
    byWeek.set(g.week, [...(byWeek.get(g.week) ?? []), g]);
  }
  return [...byWeek.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([week, list], i) => {
      const byes = list.filter((g) => g.away_team_id === null).length;
      const played = list.length - byes;
      return {
        index: i + 1,
        from: week,
        to: week + list[0].week_count - 1,
        field: byes + played * 2,
        byes,
        games: played,
        advancing: byes + played,
      } satisfies RoundShape;
    });
}

/** The same scenario, on paper. */
function paper(s: Scenario) {
  const winners = winnersShape({
    playoffStartWeek: s.playoffStartWeek,
    playoffTeams: s.playoffTeams,
    teamCount: s.teams,
    rounds: full(s.winners),
  });
  const entrants = losersEntrantCount(s.settings, winners, s.teams);
  assert.ok("count" in entrants, "the preview can work out the entrants");
  const losers = losersShape(s.settings.startWeek!, entrants.count, full(s.losers));
  return { winners, losers, entrants: entrants.count };
}

describe("losers bracket: consolation, knocked-out teams, re-seeded", () => {
  const s: Scenario = {
    name: "lb-consolation",
    teams: 8,
    playoffTeams: 8,
    playoffStartWeek: 15,
    winners: [{}, {}, {}],
    losers: [{ teams: 4, name: "Losers Semis" }, {}],
    settings: {
      enabled: true,
      entrants: "eliminated_playoff_teams",
      mode: "consolation",
      reseed: "reseed",
      startWeek: 16,
    },
  };

  test("plays round by round with its own names, and the season waits for it", async () => {
    const f = await setup(s);
    const playoffSeeds = await seedsOf(f.leagueId, "winners");

    assert.equal((await games(f.leagueId, "losers")).length, 0, "nobody is out yet");
    assert.equal(validateLosersBracket({
      settings: s.settings,
      rounds: full(s.losers),
      playoffStartWeek: 15,
      playoffTeams: 8,
      teamCount: 8,
      winnersRounds: full(s.winners),
    }).length, 0, "the save validation accepts it");

    await finish(f.leagueId, "winners", 15);
    await advance(f.leagueId, 15);

    // Seeds 5-8 went out in round one and are re-seeded 1-4.
    const losersSeeds = await seedsOf(f.leagueId, "losers");
    assert.deepEqual(losersSeeds, playoffSeeds.slice(4));

    const round1 = await games(f.leagueId, "losers", 16);
    assert.equal(round1.length, 2);
    assert.ok(round1.every((g) => g.playoff_round === "Losers Semis"));
    const pairs = round1
      .map((g) => [losersSeeds.indexOf(g.home_team_id) + 1, losersSeeds.indexOf(g.away_team_id!) + 1])
      .sort((a, b) => a[0] - b[0]);
    assert.deepEqual(pairs, [[1, 4], [2, 3]]);

    // Seed 3 upsets seed 2; winners advance, so 1 meets 3.
    await finish(f.leagueId, "winners", 16);
    await finish(f.leagueId, "losers", 16, [losersSeeds[2]]);
    await advance(f.leagueId, 16);

    const final = await games(f.leagueId, "losers", 17);
    assert.equal(final.length, 1);
    assert.equal(final[0].playoff_round, "Consolation Final", "unnamed round gets the fallback");
    assert.deepEqual(
      [final[0].home_team_id, final[0].away_team_id],
      [losersSeeds[0], losersSeeds[2]],
    );

    // The championship finishes first: not complete while the
    // consolation final is still open.
    await finish(f.leagueId, "winners", 17);
    await assert.rejects(() => advance(f.leagueId, 17), /not final/);
    assert.equal(await status(f.leagueId), "playoffs");

    await finish(f.leagueId, "losers", 17);
    assert.equal(await advance(f.leagueId, 17), 0);
    assert.equal(await status(f.leagueId), "complete");

    const plan = paper(s);
    assert.deepEqual(await dbShape(f.leagueId, "winners"), plan.winners);
    assert.deepEqual(await dbShape(f.leagueId, "losers"), plan.losers);
    assert.equal(plan.entrants, losersSeeds.length);
  });
});

describe("losers bracket: toilet bowl, non-playoff teams, multi-week round", () => {
  const s: Scenario = {
    name: "lb-toilet",
    teams: 8,
    playoffTeams: 4,
    playoffStartWeek: 15,
    winners: [{}, {}],
    losers: [{ teams: 4 }, { weeks: 2, name: "The Toilet Bowl" }],
    settings: {
      enabled: true,
      entrants: "non_playoff_teams",
      mode: "toilet_bowl",
      reseed: "reseed",
      startWeek: 15,
    },
  };

  test("losers advance, the worst record is the top seed, and the last team standing is last", async () => {
    const f = await setup(s);

    // Teams 5-8 missed the playoffs; the worst record is seeded first.
    const losersSeeds = await seedsOf(f.leagueId, "losers");
    assert.deepEqual(losersSeeds, f.standings.slice(4).reverse());

    const round1 = await games(f.leagueId, "losers", 15);
    assert.equal(round1.length, 2, "created with the winners bracket");
    assert.ok(round1.every((g) => g.playoff_round === "Toilet Bowl Round 1"));

    // Home (the worse team) wins both, so the away sides go through.
    await finish(f.leagueId, "winners", 15);
    await finish(f.leagueId, "losers", 15);
    await advance(f.leagueId, 15);

    const round2 = await games(f.leagueId, "losers", 16);
    assert.equal(round2.length, 1);
    assert.equal(round2[0].week_count, 2, "a two-week round");
    assert.equal(round2[0].playoff_round, "The Toilet Bowl");
    assert.deepEqual(
      [round2[0].home_team_id, round2[0].away_team_id],
      [losersSeeds[2], losersSeeds[3]],
      "the losers of 1v4 and 2v3, re-seeded",
    );

    // The final is over after week 16; the toilet bowl runs to 17.
    await finish(f.leagueId, "winners", 16);
    await assert.rejects(() => advance(f.leagueId, 16), /not final/);
    assert.equal(await status(f.leagueId), "playoffs", "waits for the losers bracket");

    await finish(f.leagueId, "losers", 16);
    await advance(f.leagueId, 17);
    assert.equal(await status(f.leagueId), "complete");

    const last = await db.one<{ team_id: string }>(
      "select team_id from public.playoff_round_advancers($1, $2, 'losers', 16, true)",
      [f.leagueId, SEASON],
    );
    assert.equal(last.team_id, losersSeeds[3], "the home side won, so the away side is last");

    const plan = paper(s);
    assert.deepEqual(await dbShape(f.leagueId, "losers"), plan.losers);
    assert.deepEqual(plan.losers.map((r) => [r.from, r.to]), [[15, 15], [16, 17]]);
  });
});

describe("losers bracket: both kinds of entrant, byes, fixed vs re-seeded", () => {
  function scenario(reseed: "fixed" | "reseed"): Scenario {
    return {
      name: `lb-both-${reseed}`,
      teams: 8,
      playoffTeams: 4,
      playoffStartWeek: 15,
      winners: [{}, {}],
      losers: [{ teams: 6, byes: 2 }, {}, {}],
      settings: {
        enabled: true,
        entrants: "both",
        mode: "consolation",
        reseed,
        startWeek: 16,
      },
    };
  }

  async function playTwoRounds(s: Scenario) {
    const f = await setup(s);
    const playoffSeeds = await seedsOf(f.leagueId, "winners");

    await finish(f.leagueId, "winners", 15);
    await advance(f.leagueId, 15);

    // Knocked out: playoff seeds 3 and 4. Then teams 5-8 by record.
    const losersSeeds = await seedsOf(f.leagueId, "losers");
    assert.deepEqual(losersSeeds, [...playoffSeeds.slice(2), ...f.standings.slice(4)]);

    const round1 = await games(f.leagueId, "losers", 16);
    const byes = round1.filter((g) => g.away_team_id === null).map((g) => g.home_team_id);
    assert.deepEqual(byes.sort(), [losersSeeds[0], losersSeeds[1]].sort(), "top two sit out");
    assert.equal(round1.length - byes.length, 2, "3v6 and 4v5");

    // 6 upsets 3; 4 beats 5.
    await finish(f.leagueId, "winners", 16);
    await finish(f.leagueId, "losers", 16, [losersSeeds[5]]);
    await advance(f.leagueId, 16);

    const round2 = await games(f.leagueId, "losers", 17);
    const pairs = round2
      .map((g) => [losersSeeds.indexOf(g.home_team_id) + 1, losersSeeds.indexOf(g.away_team_id!) + 1])
      .sort((a, b) => a[0] - b[0]);

    assert.deepEqual(await dbShape(f.leagueId, "losers"), paper(s).losers.slice(0, 2));
    return { f, pairs };
  }

  test("fixed: the top seed meets the winner of 4v5 whoever wins 3v6", async () => {
    const { pairs } = await playTwoRounds(scenario("fixed"));
    assert.deepEqual(pairs, [[1, 4], [2, 6]]);
  });

  test("reseed: the top seed meets the lowest seed left", async () => {
    const { pairs } = await playTwoRounds(scenario("reseed"));
    assert.deepEqual(pairs, [[1, 6], [2, 4]]);
  });
});

describe("losers bracket: switched off", () => {
  test("configured rounds are ignored and the final completes the season", async () => {
    const s: Scenario = {
      name: "lb-disabled",
      teams: 4,
      playoffTeams: 4,
      playoffStartWeek: 15,
      winners: [{}, {}],
      losers: [{ teams: 2 }],
      settings: { enabled: false, entrants: null, mode: null, reseed: null, startWeek: null },
    };
    const f = await setup(s);

    await finish(f.leagueId, "winners", 15);
    await advance(f.leagueId, 15);
    await finish(f.leagueId, "winners", 16);
    await advance(f.leagueId, 16);

    assert.equal((await games(f.leagueId, "losers")).length, 0);
    assert.equal(await status(f.leagueId), "complete");
    assert.deepEqual(
      validateLosersBracket({
        settings: s.settings,
        rounds: full(s.losers),
        playoffStartWeek: 15,
        playoffTeams: 4,
        teamCount: 4,
        winnersRounds: full(s.winners),
      }),
      [],
    );
  });

  test("an enabled losers bracket must make every choice", async () => {
    const f = await buildLeague(db, "lb-constraint");
    await assert.rejects(
      () =>
        db.q(
          "update public.leagues set losers_bracket_enabled = true where id = $1",
          [f.leagueId],
        ),
      /leagues_losers_bracket_chosen/,
    );
  });

  test("switched off after its games exist, the season still waits for them", async () => {
    const s: Scenario = {
      name: "lb-disabled-midway",
      teams: 8,
      playoffTeams: 2,
      playoffStartWeek: 15,
      winners: [{}],
      losers: [{ teams: 6 }, {}, {}],
      settings: {
        enabled: true,
        entrants: "non_playoff_teams",
        mode: "consolation",
        reseed: "reseed",
        startWeek: 15,
      },
    };
    const f = await setup(s);
    assert.equal((await games(f.leagueId, "losers", 15)).length, 3, "the losers bracket started");

    await db.q("update public.leagues set losers_bracket_enabled = false where id = $1", [f.leagueId]);

    await finish(f.leagueId, "winners", 15);
    await assert.rejects(() => advance(f.leagueId, 15), /not final/);
    assert.equal(await status(f.leagueId), "playoffs", "its open games keep the season open");

    // The championship is decided and the losers round is final: the old
    // code completed the league here. The losers bracket carries on.
    await finish(f.leagueId, "losers", 15);
    assert.ok((await advance(f.leagueId, 15)) > 0);
    const round2 = await games(f.leagueId, "losers", 16);
    assert.equal(round2.length, 2, "3 through: one game and one bye");
    assert.equal(await status(f.leagueId), "playoffs", "not complete with round 2 still to play");

    await finish(f.leagueId, "losers", 16);
    await advance(f.leagueId, 16);
    assert.equal((await games(f.leagueId, "losers", 17)).length, 1, "the final");
    assert.equal(await status(f.leagueId), "playoffs");

    await finish(f.leagueId, "losers", 17);
    await advance(f.leagueId, 17);
    assert.equal(await status(f.leagueId), "complete");
  });

  test("generating refuses a losers bracket that starts before the playoffs", async () => {
    const f = await buildLeague(db, "lb-early-start");
    await db.q(
      `update public.leagues
         set playoff_teams = 2, playoff_start_week = 17, losers_bracket_enabled = true,
             losers_entrants = 'non_playoff_teams', losers_mode = 'consolation',
             losers_reseed = 'reseed', losers_start_week = 16
       where id = $1`,
      [f.leagueId],
    );
    await assert.rejects(
      () => db.q("select public.generate_playoffs($1)", [f.leagueId]),
      /before the playoffs start/,
    );
  });
});

describe("losers bracket: starts after the final", () => {
  const s: Scenario = {
    name: "lb-after-final",
    teams: 4,
    playoffTeams: 4,
    playoffStartWeek: 15,
    winners: [{}, {}],
    losers: [{ teams: 3, byes: 1 }, {}],
    settings: {
      enabled: true,
      entrants: "eliminated_playoff_teams",
      mode: "consolation",
      reseed: "reseed",
      startWeek: 17,
    },
  };

  test("everyone but the champion enters, once the final is decided", async () => {
    const f = await setup(s);
    const plan = paper(s);
    assert.equal(plan.entrants, 3);

    await finish(f.leagueId, "winners", 15);
    await advance(f.leagueId, 15);
    assert.equal((await games(f.leagueId, "losers")).length, 0, "not before the semi-finals are decided");

    await finish(f.leagueId, "winners", 16);
    await advance(f.leagueId, 16);

    const playoffSeeds = await seedsOf(f.leagueId, "winners");
    const losersSeeds = await seedsOf(f.leagueId, "losers");
    assert.equal(losersSeeds.length, plan.entrants);
    assert.deepEqual(losersSeeds, playoffSeeds.slice(1), "the home side won every game, so seed 1 is champion");
    assert.equal(await status(f.leagueId), "playoffs", "the final is over, the losers bracket is not");

    await finish(f.leagueId, "losers", 17);
    await advance(f.leagueId, 17);
    assert.equal(await status(f.leagueId), "playoffs");

    await finish(f.leagueId, "losers", 18);
    await advance(f.leagueId, 18);
    assert.equal(await status(f.leagueId), "complete");

    assert.deepEqual(await dbShape(f.leagueId, "losers"), plan.losers);
  });
});

describe("losers bracket: toilet bowl, fixed, with byes", () => {
  const s: Scenario = {
    name: "lb-toilet-fixed",
    teams: 8,
    playoffTeams: 2,
    playoffStartWeek: 15,
    winners: [{}],
    losers: [{ teams: 6, byes: 2 }, {}, {}],
    settings: {
      enabled: true,
      entrants: "non_playoff_teams",
      mode: "toilet_bowl",
      reseed: "fixed",
      startWeek: 15,
    },
  };

  test("losers advance through a fixed draw, and the shape matches the preview", async () => {
    const f = await setup(s);
    const seeds = await seedsOf(f.leagueId, "losers");
    assert.deepEqual(seeds, f.standings.slice(2).reverse(), "worst record first");

    // Home wins everywhere, so the away sides (6 and 5) go through.
    await finish(f.leagueId, "winners", 15);
    await finish(f.leagueId, "losers", 15);
    await advance(f.leagueId, 15);

    // Fixed: 6 took 3v6's place in the draw and 5 took 4v5's, so seed 1
    // meets 5 and seed 2 meets 6. (Re-seeded it would be 1v6, 2v5.)
    const round2 = (await games(f.leagueId, "losers", 16))
      .map((g) => [seeds.indexOf(g.home_team_id) + 1, seeds.indexOf(g.away_team_id!) + 1])
      .sort((a, b) => a[0] - b[0]);
    assert.deepEqual(round2, [[1, 5], [2, 6]]);
    assert.equal(await status(f.leagueId), "playoffs");

    await finish(f.leagueId, "losers", 16);
    await advance(f.leagueId, 16);
    await finish(f.leagueId, "losers", 17);
    await advance(f.leagueId, 17);
    assert.equal(await status(f.leagueId), "complete");

    const last = await db.one<{ team_id: string }>(
      "select team_id from public.playoff_round_advancers($1, $2, 'losers', 17, true)",
      [f.leagueId, SEASON],
    );
    assert.equal(last.team_id, seeds[5], "5 v 6 in the final, home wins, 6 is last");

    assert.deepEqual(await dbShape(f.leagueId, "losers"), paper(s).losers);
  });
});

describe("preview and database agree on the losers bracket's weeks", () => {
  const cases: { start: number; weeks: number[] }[] = [
    { start: 15, weeks: [1, 1] },
    { start: 16, weeks: [2, 1] },
    { start: 14, weeks: [1, 2, 1] },
    { start: 17, weeks: [1, 1] },
    { start: 15, weeks: [3, 1, 1] },
  ];

  for (const c of cases) {
    test(`start ${c.start}, rounds of ${c.weeks.join("/")} weeks`, async () => {
      const f = await buildLeague(db, `lb-weeks-${c.start}-${c.weeks.join("")}`);
      await db.q(
        `update public.leagues
           set playoff_start_week = 14, losers_bracket_enabled = true,
               losers_entrants = 'non_playoff_teams', losers_mode = 'consolation',
               losers_reseed = 'fixed', losers_start_week = $2
         where id = $1`,
        [f.leagueId, c.start],
      );
      for (let i = 0; i < c.weeks.length; i++) {
        await db.q(
          `insert into public.league_playoff_rounds (league_id, bracket, round_index, weeks)
           values ($1, 'losers', $2, $3), ($1, 'winners', $2, $3)`,
          [f.leagueId, i + 1, c.weeks[i]],
        );
      }

      const spans = roundSpans(c.start, c.weeks.map((weeks) => ({ weeks })));
      for (let i = 0; i < c.weeks.length; i++) {
        const row = await db.one<{ start: number; weeks: number }>(
          `select public.playoff_round_start($1, 'losers', $2) as start,
                  public.playoff_round_weeks($1, 'losers', $2) as weeks`,
          [f.leagueId, i + 1],
        );
        assert.equal(row.start, spans[i].from, `round ${i + 1} starts`);
        assert.equal(row.start + row.weeks - 1, spans[i].to, `round ${i + 1} ends`);
      }

      // The winners bracket still counts from the playoff start.
      const winners = await db.one<{ start: number }>(
        "select public.playoff_round_start($1, 'winners', 1) as start",
        [f.leagueId],
      );
      assert.equal(winners.start, 14);
    });
  }
});

describe("losers bracket validation (the save action's rules)", () => {
  const base = {
    playoffStartWeek: 15,
    playoffTeams: 6,
    teamCount: 10,
    winnersRounds: full([{ teams: 6, byes: 2 }, {}, {}]),
  };
  const on = (over: Partial<LosersSettings>): LosersSettings => ({
    enabled: true,
    entrants: "eliminated_playoff_teams",
    mode: "consolation",
    reseed: "fixed",
    startWeek: 16,
    ...over,
  });

  test("entrants follow the winners bracket and the start week", () => {
    const winners = winnersShape({ ...base, rounds: base.winnersRounds });
    assert.deepEqual(
      winners.map((r) => [r.from, r.field, r.byes, r.games]),
      [[15, 6, 2, 2], [16, 4, 0, 2], [17, 2, 0, 1]],
    );
    const count = (s: LosersSettings) => losersEntrantCount(s, winners, 10);
    assert.deepEqual(count(on({})), { count: 2 });
    assert.deepEqual(count(on({ startWeek: 17 })), { count: 4 });
    assert.deepEqual(count(on({ startWeek: 18 })), { count: 5 }, "after the final: all but the champion");
    assert.deepEqual(count(on({ entrants: "non_playoff_teams" })), { count: 4 });
    assert.deepEqual(count(on({ entrants: "both", startWeek: 17 })), { count: 8 });
  });

  test("a start week inside a multi-week winners round is refused", () => {
    const winners = winnersShape({ ...base, rounds: full([{ weeks: 2, teams: 6, byes: 2 }, {}, {}]) });
    const result = losersEntrantCount(on({ startWeek: 16 }), winners, 10);
    assert.ok("error" in result && /middle of winners round 1/.test(result.error));
  });

  test("accepts a bracket that narrows to one team in time", () => {
    assert.deepEqual(
      validateLosersBracket({ ...base, settings: on({ entrants: "both" }), rounds: full([{ teams: 6 }, {}, {}]) }),
      [],
    );
  });

  test("refuses a round one that does not match the entrants", () => {
    const errors = validateLosersBracket({ ...base, settings: on({}), rounds: full([{ teams: 4 }, {}]) });
    assert.ok(errors.some((e) => /set for 4 teams, but 2 enter/.test(e)), errors.join("; "));
  });

  test("refuses rounds that leave more than one team standing", () => {
    const errors = validateLosersBracket({ ...base, settings: on({ entrants: "non_playoff_teams" }), rounds: full([{ teams: 4 }]) });
    assert.ok(errors.some((e) => /2 teams still standing/.test(e)), errors.join("; "));
  });

  test("refuses a round with nobody left, or more teams than are left", () => {
    const extra = validateLosersBracket({ ...base, settings: on({}), rounds: full([{ teams: 2 }, {}]) });
    assert.ok(extra.some((e) => /nobody left/.test(e)), extra.join("; "));
    const grown = validateLosersBracket({ ...base, settings: on({ entrants: "non_playoff_teams" }), rounds: full([{ teams: 4 }, { teams: 3 }]) });
    assert.ok(grown.some((e) => /only 2 are left/.test(e)), grown.join("; "));
  });

  test("a fixed bracket cannot drop teams after round 1; a re-seeded one can", () => {
    const rounds = full([{ teams: 8 }, { teams: 2 }, {}]);
    const settings = { entrants: "both" as const, startWeek: 17 };
    const fixed = validateLosersBracket({ ...base, teamCount: 12, settings: on({ ...settings, reseed: "fixed" }), rounds });
    assert.ok(
      fixed.some((e) => /fixed bracket can't drop teams after round 1\. Leave round 2's teams blank/.test(e)),
      fixed.join("; "),
    );
    // 12 teams, 6 in the playoffs: 2 out by week 16 plus 6 non-playoff = 8.
    const reseed = validateLosersBracket({
      ...base,
      teamCount: 12,
      settings: on({ ...settings, startWeek: 16, reseed: "reseed" }),
      rounds: full([{ teams: 8 }, { teams: 2 }]),
    });
    assert.deepEqual(reseed, []);
  });

  test("refuses a bracket that runs past the NFL season", () => {
    const errors = validateLosersBracket({
      ...base,
      settings: on({ entrants: "non_playoff_teams", startWeek: 17 }),
      rounds: full([{ teams: 4, weeks: 2 }, {}]),
    });
    assert.ok(errors.some((e) => /past the end of the NFL season/.test(e)), errors.join("; "));
  });

  test("refuses missing choices and a start before the playoffs", () => {
    assert.equal(validateLosersBracket({ ...base, settings: on({ mode: null, reseed: null }), rounds: full([{}]) }).length, 2);
    const early = validateLosersBracket({ ...base, settings: on({ entrants: "non_playoff_teams", startWeek: 14 }), rounds: full([{ teams: 4 }, {}]) });
    assert.ok(early.some((e) => /before the playoffs/.test(e)), early.join("; "));
  });

  test("settleByes matches playoff_round_byes", async () => {
    for (let field = 0; field <= 9; field++) {
      for (let requested = 0; requested <= 9; requested++) {
        const row = await db.one<{ n: number }>(
          "select public.playoff_round_byes($1, $2) as n",
          [field, requested],
        );
        assert.equal(settleByes(field, requested), row.n, `${field} teams, ${requested} byes`);
      }
    }
  });
});

describe("0040 maps existing leagues", () => {
  test("a league with losers rounds keeps its behaviour; one without is disabled", async () => {
    const pg = await createBareDb();
    try {
      for (const file of migrationFiles().filter((f) => f < "0040")) {
        await applyMigration(pg, file);
      }

      const user = (
        await pg.query<{ id: string }>(
          "insert into auth.users (email) values ('map@example.com') returning id",
        )
      ).rows[0].id;
      await pg.query(
        "insert into public.profiles (id, email, display_name) values ($1, 'map@example.com', 'Map') on conflict (id) do nothing",
        [user],
      );
      await pg.query("select set_config('test.uid', $1, false)", [user]);

      const league = async (name: string) =>
        (
          await pg.query<{ id: string }>(
            `insert into public.leagues (name, season, commissioner_id, team_count, playoff_start_week)
             values ($1, $2, $3, 4, 15) returning id`,
            [name, SEASON, user],
          )
        ).rows[0].id;

      const withLosers = await league("map-with");
      const without = await league("map-without");
      await pg.query(
        `insert into public.league_playoff_rounds (league_id, bracket, round_index, weeks)
         values ($1, 'winners', 1, 2), ($1, 'winners', 2, 1), ($1, 'losers', 1, 1)`,
        [withLosers],
      );

      await applyMigration(pg, migrationFiles().find((f) => f.startsWith("0040"))!);

      const rows = (
        await pg.query<Record<string, unknown>>(
          `select id, losers_bracket_enabled, losers_entrants, losers_mode,
                  losers_reseed, losers_start_week
           from public.leagues where id in ($1, $2)`,
          [withLosers, without],
        )
      ).rows;
      const byId = new Map(rows.map((r) => [r.id, r]));

      assert.deepEqual(
        { ...byId.get(withLosers), id: undefined },
        {
          id: undefined,
          losers_bracket_enabled: true,
          losers_entrants: "eliminated_playoff_teams",
          losers_mode: "consolation",
          losers_reseed: "reseed",
          losers_start_week: 17,
        },
        "starts the week after a two-week winners round one",
      );
      assert.deepEqual(
        { ...byId.get(without), id: undefined },
        {
          id: undefined,
          losers_bracket_enabled: false,
          losers_entrants: null,
          losers_mode: null,
          losers_reseed: null,
          losers_start_week: null,
        },
      );
    } finally {
      await pg.close();
    }
  });
});
