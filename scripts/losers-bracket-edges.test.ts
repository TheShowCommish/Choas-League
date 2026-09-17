/**
 * Edge cases for the losers bracket (T-008), played through the real SQL
 * on PGlite and checked against the preview in src/lib/playoff-bracket.ts.
 *
 * Covers: odd fields with byes in both modes and both seedings, `both`
 * entrants with a tiny non-playoff pool, a start week on the last week of
 * a multi-week winners round, brackets that never get two teams, a tie in
 * a toilet bowl, regenerating mid-bracket, double-advancing, two leagues
 * side by side, and the settings guard the save actions run.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, type TestDb } from "./lib/test-db.ts";
import { SEASON, buildLeague } from "./lib/fixtures.ts";
import {
  losersEntrantCount,
  losersShape,
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
type Round = Partial<RoundConfig>;

interface Scenario {
  name: string;
  teams: number;
  playoffTeams: number;
  playoffStartWeek: number;
  winners: Round[];
  losers: Round[];
  settings: LosersSettings;
}

const full = (rounds: Round[]): RoundConfig[] =>
  rounds.map((r) => ({
    name: r.name ?? "",
    weeks: r.weeks ?? 1,
    teams: r.teams ?? null,
    byes: r.byes ?? 0,
  }));

async function setup(s: Scenario, generate = true) {
  const f = await buildLeague(db, s.name);
  await db.q("select public.set_team_count($1, $2)", [f.leagueId, s.teams]);
  const teamIds = (
    await db.q<{ id: string }>(
      "select id from public.teams where league_id = $1 order by created_at, id",
      [f.leagueId],
    )
  ).map((t) => t.id);

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

  if (generate) await db.q("select public.generate_playoffs($1)", [f.leagueId]);
  return { ...f, standings: teamIds };
}

interface Game {
  id: string;
  week: number;
  week_count: number;
  home_team_id: string;
  away_team_id: string | null;
  home_score: number;
  away_score: number;
  playoff_round: string;
  status: string;
}

const games = (leagueId: string, bracket: Bracket, week?: number) =>
  db.q<Game>(
    `select id, week, week_count, home_team_id, away_team_id, home_score,
            away_score, playoff_round, status
     from public.matchups
     where league_id = $1 and is_playoff and bracket = $2
       and ($3::int is null or week = $3)
     order by week, home_team_id`,
    [leagueId, bracket, week ?? null],
  );

const seedsOf = async (leagueId: string, bracket: Bracket) =>
  (
    await db.q<{ team_id: string }>(
      "select team_id from public.playoff_seeds where league_id = $1 and bracket = $2 order by seed",
      [leagueId, bracket],
    )
  ).map((r) => r.team_id);

async function finish(leagueId: string, bracket: Bracket, week: number, score?: (g: Game) => [number, number]) {
  for (const g of await games(leagueId, bracket, week)) {
    if (g.status === "final") continue;
    const [h, a] = score ? score(g) : [100, 50];
    await db.q(
      "update public.matchups set home_score = $2, away_score = $3, status = 'final' where id = $1",
      [g.id, h, a],
    );
  }
}

const advance = async (leagueId: string, week: number) =>
  (await db.one<{ n: number }>("select public.advance_playoffs($1, $2) as n", [leagueId, week])).n;

const status = async (leagueId: string) =>
  (await db.one<{ status: string }>("select status from public.leagues where id = $1", [leagueId])).status;

async function dbShape(leagueId: string, bracket: Bracket): Promise<RoundShape[]> {
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
      };
    });
}

function paper(s: Scenario) {
  const winners = winnersShape({
    playoffStartWeek: s.playoffStartWeek,
    playoffTeams: s.playoffTeams,
    teamCount: s.teams,
    rounds: full(s.winners),
  });
  const entrants = losersEntrantCount(s.settings, winners, s.teams);
  assert.ok("count" in entrants, "the preview can work out the entrants");
  return {
    winners,
    entrants: entrants.count,
    losers: losersShape(s.settings.startWeek!, entrants.count, full(s.losers)),
  };
}

const validate = (s: Scenario, over: Partial<{ playoffStartWeek: number; playoffTeams: number; teamCount: number }> = {}) =>
  validateLosersBracket({
    settings: s.settings,
    rounds: full(s.losers),
    playoffStartWeek: over.playoffStartWeek ?? s.playoffStartWeek,
    playoffTeams: over.playoffTeams ?? s.playoffTeams,
    teamCount: over.teamCount ?? s.teams,
    winnersRounds: full(s.winners),
  });

/**
 * Plays every open game week by week (home side wins unless `score` says
 * otherwise) and advances, until the league is complete. Returns the
 * week the league completed in. Asserts it never completes while any
 * playoff game is open, and that no team plays twice in a week.
 */
async function playOut(leagueId: string, from: number, score?: (g: Game) => [number, number]) {
  for (let week = from; week <= 22; week++) {
    await finish(leagueId, "winners", week, score);
    await finish(leagueId, "losers", week, score);
    try {
      await advance(leagueId, week);
    } catch (err) {
      // A multi-week round still open, or nothing starting this week yet.
      if (!/not final|No playoff round covers/.test((err as Error).message)) throw err;
    }

    const clash = await db.q(
      `select t, week from (
         select home_team_id as t, week from public.matchups where league_id = $1 and is_playoff
         union all
         select away_team_id, week from public.matchups where league_id = $1 and is_playoff and away_team_id is not null
       ) x group by t, week having count(*) > 1`,
      [leagueId],
    );
    assert.deepEqual(clash, [], `a team is scheduled twice in one week (week ${week})`);

    if ((await status(leagueId)) === "complete") {
      const open = await db.q(
        "select id from public.matchups where league_id = $1 and is_playoff and status <> 'final'",
        [leagueId],
      );
      assert.deepEqual(open, [], "complete with playoff games still open");
      return week;
    }
  }
  assert.fail("the league never completed");
}

// ---------------------------------------------------------------------------

describe("odd losers fields with byes, every mode and seeding", () => {
  for (const entrants of [3, 5, 7]) {
    for (const mode of ["consolation", "toilet_bowl"] as const) {
      for (const reseed of ["fixed", "reseed"] as const) {
        test(`${entrants} entrants, ${mode}, ${reseed}`, async () => {
          const rounds = entrants === 3 ? 2 : 3;
          const s: Scenario = {
            name: `lbe-odd-${entrants}-${mode}-${reseed}`,
            teams: entrants + 2,
            playoffTeams: 2,
            playoffStartWeek: 15,
            winners: [{}],
            losers: [{ byes: 1 }, ...Array.from({ length: rounds - 1 }, () => ({}))],
            settings: { enabled: true, entrants: "non_playoff_teams", mode, reseed, startWeek: 15 },
          };
          assert.deepEqual(validate(s), [], "the save validation accepts it");

          const f = await setup(s);
          const seeds = await seedsOf(f.leagueId, "losers");
          assert.equal(seeds.length, entrants);
          const nonPlayoff = f.standings.slice(2);
          assert.deepEqual(
            seeds,
            mode === "toilet_bowl" ? [...nonPlayoff].reverse() : nonPlayoff,
            mode === "toilet_bowl" ? "worst record first" : "best record first",
          );

          const round1 = await games(f.leagueId, "losers", 15);
          const bye = round1.filter((g) => g.away_team_id === null);
          assert.equal(bye.length, 1);
          assert.equal(bye[0].home_team_id, seeds[0], "the top seed takes the bye");
          assert.equal(bye[0].playoff_round, "Bye");

          const done = await playOut(f.leagueId, 15);
          const plan = paper(s);
          assert.deepEqual(await dbShape(f.leagueId, "losers"), plan.losers);
          assert.equal(done, plan.losers[plan.losers.length - 1].to, "completes the week the losers final ends");

          // Every configured round was a real round, and the last one has
          // exactly one team going through.
          const lastWeek = plan.losers[plan.losers.length - 1].from;
          const last = await db.q<{ team_id: string }>(
            "select team_id from public.playoff_round_advancers($1, $2, 'losers', $3, $4)",
            [f.leagueId, SEASON, lastWeek, mode === "toilet_bowl"],
          );
          assert.equal(last.length, 1);
          if (mode === "consolation") {
            assert.equal(last[0].team_id, seeds[0], "home always won, so the top seed is best of the rest");
          }

          // Names: nothing hard-coded beyond the mode's fallback.
          const prefix = mode === "toilet_bowl" ? "Toilet Bowl" : "Consolation";
          for (const g of await games(f.leagueId, "losers")) {
            if (g.away_team_id === null) continue;
            assert.match(g.playoff_round, new RegExp(`^${prefix} (Round \\d|Final)`));
          }
        });
      }
    }
  }
});

describe("`both` entrants with a tiny non-playoff pool", () => {
  test("nobody missed the playoffs: only the knocked-out teams play", async () => {
    const s: Scenario = {
      name: "lbe-both-pool0",
      teams: 4,
      playoffTeams: 4,
      playoffStartWeek: 15,
      winners: [{}, {}],
      losers: [{}],
      settings: { enabled: true, entrants: "both", mode: "consolation", reseed: "reseed", startWeek: 16 },
    };
    assert.deepEqual(validate(s), []);
    const f = await setup(s);
    assert.equal((await games(f.leagueId, "losers")).length, 0, "nothing known at generation");

    await finish(f.leagueId, "winners", 15);
    await advance(f.leagueId, 15);
    const winnersSeeds = await seedsOf(f.leagueId, "winners");
    assert.deepEqual(await seedsOf(f.leagueId, "losers"), winnersSeeds.slice(2));
    assert.equal(await playOut(f.leagueId, 16), 16);
    assert.deepEqual(await dbShape(f.leagueId, "losers"), paper(s).losers);
  });

  test("one team missed the playoffs and it starts with them: refused, and never blocks completion", async () => {
    const s: Scenario = {
      name: "lbe-both-pool1",
      teams: 5,
      playoffTeams: 4,
      playoffStartWeek: 15,
      winners: [{}, {}],
      losers: [{}],
      settings: { enabled: true, entrants: "both", mode: "toilet_bowl", reseed: "fixed", startWeek: 15 },
    };
    const errors = validate(s);
    assert.ok(errors.some((e) => /Only 1 team would enter/.test(e)), errors.join("; "));

    const f = await setup(s);
    assert.equal((await games(f.leagueId, "losers")).length, 0);
    assert.equal(await playOut(f.leagueId, 15), 16, "completes with the final");
  });

  test("one team missed the playoffs and it starts a round later: 2 knocked out + 1 = 3", async () => {
    const s: Scenario = {
      name: "lbe-both-pool1-later",
      teams: 5,
      playoffTeams: 4,
      playoffStartWeek: 15,
      winners: [{}, {}],
      losers: [{ teams: 3, byes: 1 }, {}],
      settings: { enabled: true, entrants: "both", mode: "consolation", reseed: "fixed", startWeek: 16 },
    };
    assert.deepEqual(validate(s), []);
    const f = await setup(s);
    await finish(f.leagueId, "winners", 15);
    await advance(f.leagueId, 15);
    const winnersSeeds = await seedsOf(f.leagueId, "winners");
    assert.deepEqual(await seedsOf(f.leagueId, "losers"), [...winnersSeeds.slice(2), f.standings[4]]);
    assert.equal(await playOut(f.leagueId, 16), 17);
    assert.deepEqual(await dbShape(f.leagueId, "losers"), paper(s).losers);
  });
});

describe("start week against a multi-week winners round", () => {
  const base = (startWeek: number): Scenario => ({
    name: `lbe-multi-${startWeek}`,
    teams: 4,
    playoffTeams: 4,
    playoffStartWeek: 15,
    winners: [{ weeks: 2 }, {}],
    losers: [{}],
    settings: { enabled: true, entrants: "eliminated_playoff_teams", mode: "consolation", reseed: "reseed", startWeek },
  });

  test("on the last week of a two-week semi-final: refused by the save validation", () => {
    const errors = validate(base(16));
    assert.ok(errors.some((e) => /middle of winners round 1 \(weeks 15-16\)/.test(e)), errors.join("; "));
  });

  test("the week the final starts: the semi-final losers play alongside it", async () => {
    const s = base(17);
    assert.deepEqual(validate(s), []);
    const f = await setup(s);
    assert.equal((await games(f.leagueId, "losers")).length, 0);
    await finish(f.leagueId, "winners", 15);
    assert.equal(await advance(f.leagueId, 16), 2, "final + losers final created together");
    assert.deepEqual((await games(f.leagueId, "losers")).map((g) => g.week), [17]);
    assert.equal(await playOut(f.leagueId, 17), 17);
    assert.deepEqual(await dbShape(f.leagueId, "losers"), paper(s).losers);
  });

  test("a two-week final with the losers bracket starting on its last week is refused", () => {
    const s = { ...base(17), winners: [{}, { weeks: 2 }] };
    const errors = validate(s);
    assert.ok(errors.some((e) => /middle of winners round 2 \(weeks 16-17\)/.test(e)), errors.join("; "));
  });
});

describe("a losers bracket that can never have two teams", () => {
  test("knocked-out teams after a 2-team final: the one loser does not hold the season open", async () => {
    const s: Scenario = {
      name: "lbe-one-team",
      teams: 4,
      playoffTeams: 2,
      playoffStartWeek: 15,
      winners: [{}],
      losers: [{}],
      settings: { enabled: true, entrants: "eliminated_playoff_teams", mode: "toilet_bowl", reseed: "reseed", startWeek: 16 },
    };
    const errors = validate(s);
    assert.ok(errors.some((e) => /Only 1 team/.test(e)), errors.join("; "));
    const f = await setup(s);
    assert.equal(await status(f.leagueId), "playoffs");
    assert.equal(await playOut(f.leagueId, 15), 15);
    assert.equal((await games(f.leagueId, "losers")).length, 0);
  });
});

describe("a tie in a toilet bowl game", () => {
  test("the home side (the worse record) takes the tie, so the away side goes on", async () => {
    const s: Scenario = {
      name: "lbe-toilet-tie",
      teams: 6,
      playoffTeams: 2,
      playoffStartWeek: 15,
      winners: [{}],
      losers: [{}, {}],
      settings: { enabled: true, entrants: "non_playoff_teams", mode: "toilet_bowl", reseed: "reseed", startWeek: 15 },
    };
    const f = await setup(s);
    const seeds = await seedsOf(f.leagueId, "losers");
    await finish(f.leagueId, "winners", 15);
    await finish(f.leagueId, "losers", 15, () => [80, 80]);
    await advance(f.leagueId, 15);

    // Pinned current behaviour (T-010 owns the tiebreak): the tie goes to
    // the home side, which in a toilet bowl is the WORSE team, so the worse
    // team escapes and the better team drops into the next round.
    const final = await games(f.leagueId, "losers", 16);
    assert.equal(final.length, 1);
    assert.deepEqual(
      [final[0].home_team_id, final[0].away_team_id].sort(),
      [seeds[3], seeds[2]].sort(),
      "the away sides of 1v4 and 2v3 go through",
    );
    assert.equal(await playOut(f.leagueId, 16), 16);
  });
});

describe("regenerating and double-advancing", () => {
  const s: Scenario = {
    name: "lbe-regen",
    teams: 8,
    playoffTeams: 4,
    playoffStartWeek: 15,
    winners: [{}, {}],
    losers: [{ teams: 6, byes: 2 }, {}, {}],
    settings: { enabled: true, entrants: "both", mode: "consolation", reseed: "fixed", startWeek: 16 },
  };

  test("generate_playoffs again after a partial losers bracket starts both from nothing", async () => {
    const f = await setup(s);
    await finish(f.leagueId, "winners", 15);
    await advance(f.leagueId, 15);
    await finish(f.leagueId, "winners", 16);
    await finish(f.leagueId, "losers", 16);
    await advance(f.leagueId, 16);
    assert.ok((await games(f.leagueId, "losers", 17)).length > 0, "losers round 2 exists");

    await db.q("select public.generate_playoffs($1)", [f.leagueId]);
    assert.equal(await status(f.leagueId), "playoffs");
    assert.equal((await games(f.leagueId, "losers")).length, 0, "old losers games gone");
    assert.deepEqual(await seedsOf(f.leagueId, "losers"), [], "old losers seeds gone");
    assert.equal((await games(f.leagueId, "winners")).length, 2, "only round one");
    assert.ok((await games(f.leagueId, "winners")).every((g) => g.status !== "final"));

    assert.equal(await playOut(f.leagueId, 15), 18);
    assert.deepEqual(await dbShape(f.leagueId, "losers"), paper(s).losers);
  });

  test("regenerating a completed league reopens it", async () => {
    const f = await setup({ ...s, name: "lbe-regen-complete" });
    await playOut(f.leagueId, 15);
    await db.q("select public.generate_playoffs($1)", [f.leagueId]);
    assert.equal(await status(f.leagueId), "playoffs");
    assert.equal((await games(f.leagueId, "losers")).length, 0);
  });

  test("advancing the same week twice (a double-submit) never duplicates a round", async () => {
    const f = await setup({ ...s, name: "lbe-double" });
    await finish(f.leagueId, "winners", 15);
    const first = await advance(f.leagueId, 15);
    assert.ok(first > 0);
    await assert.rejects(() => advance(f.leagueId, 15));
    const counts = await db.q<{ bracket: string; week: number; n: number }>(
      `select bracket, week, count(*)::int as n from public.matchups
       where league_id = $1 and is_playoff group by bracket, week order by bracket, week`,
      [f.leagueId],
    );
    assert.deepEqual(counts, [
      { bracket: "losers", week: 16, n: 4 },
      { bracket: "winners", week: 15, n: 2 },
      { bracket: "winners", week: 16, n: 1 },
    ]);
  });
});

describe("two leagues in different states", () => {
  test("advancing one never touches the other", async () => {
    const a = await setup({
      name: "lbe-two-a",
      teams: 8,
      playoffTeams: 4,
      playoffStartWeek: 15,
      winners: [{}, {}],
      losers: [{ teams: 4 }, { weeks: 2 }],
      settings: { enabled: true, entrants: "non_playoff_teams", mode: "toilet_bowl", reseed: "reseed", startWeek: 15 },
    });
    const b = await setup({
      name: "lbe-two-b",
      teams: 8,
      playoffTeams: 4,
      playoffStartWeek: 15,
      winners: [{}, {}],
      losers: [{ teams: 4 }, {}],
      settings: { enabled: true, entrants: "non_playoff_teams", mode: "consolation", reseed: "fixed", startWeek: 15 },
    });

    await playOut(b.leagueId, 15);
    assert.equal(await status(b.leagueId), "complete");
    const bBefore = await db.q("select * from public.matchups where league_id = $1 order by id", [b.leagueId]);

    await db.actAs(a.commish);
    await finish(a.leagueId, "winners", 15);
    await finish(a.leagueId, "losers", 15);
    await advance(a.leagueId, 15);
    await finish(a.leagueId, "winners", 16);
    await assert.rejects(() => advance(a.leagueId, 16), /not final/);
    assert.equal(await status(a.leagueId), "playoffs", "A waits on its two-week toilet bowl");
    assert.equal(await status(b.leagueId), "complete");
    assert.deepEqual(
      await db.q("select * from public.matchups where league_id = $1 order by id", [b.leagueId]),
      bBefore,
    );

    // B's commissioner cannot advance A.
    await db.actAs(b.commish);
    await assert.rejects(() => advance(a.leagueId, 16), /Only the commissioner/);
    await db.actAs(a.commish);

    await playOut(a.leagueId, 16);
    assert.equal(await status(a.leagueId), "complete");
    assert.equal(await status(b.leagueId), "complete");
  });
});

describe("the settings guard (losersBracketProblems in admin/actions.ts)", () => {
  const s: Scenario = {
    name: "lbe-guard",
    teams: 10,
    playoffTeams: 6,
    playoffStartWeek: 15,
    winners: [{ teams: 6, byes: 2 }, {}, {}],
    losers: [{ teams: 4 }, {}],
    settings: { enabled: true, entrants: "non_playoff_teams", mode: "consolation", reseed: "fixed", startWeek: 15 },
  };

  test("the saved setup is valid", () => {
    assert.deepEqual(validate(s), []);
  });

  test("moving the playoff start after the losers start is refused", () => {
    const errors = validate(s, { playoffStartWeek: 16 });
    assert.ok(errors.some((e) => /can't start before the playoffs \(week 16\)/.test(e)), errors.join("; "));
  });

  test("changing the team count so the entrants no longer match round 1 is refused", () => {
    const more = validate(s, { teamCount: 12 });
    assert.ok(more.some((e) => /set for 4 teams, but 6 enter/.test(e)), more.join("; "));
    const fewer = validate(s, { teamCount: 7 });
    assert.ok(fewer.some((e) => /set for 4 teams, but 1 enter|Only 1 team/.test(e)), fewer.join("; "));
  });

  test("changing the playoff field is refused the same way", () => {
    // Round 1 of the winners bracket is capped at 6, so 8 changes nothing;
    // 4 leaves 6 teams out of the playoffs for a 4-team losers round 1.
    assert.deepEqual(validate(s, { playoffTeams: 8 }), []);
    const errors = validate(s, { playoffTeams: 4 });
    assert.ok(errors.some((e) => /set for 4 teams, but 6 enter/.test(e)), errors.join("; "));
  });

  test("a disabled bracket never blocks a settings change", () => {
    assert.deepEqual(
      validateLosersBracket({
        settings: { ...s.settings, enabled: false },
        rounds: full(s.losers),
        playoffStartWeek: 17,
        playoffTeams: 2,
        teamCount: 3,
        winnersRounds: full(s.winners),
      }),
      [],
    );
  });

  test("generate_playoffs refuses a losers start before the playoffs even if the guard was bypassed", async () => {
    const f = await setup({ ...s, name: "lbe-guard-sql" }, false);
    await db.q("update public.leagues set playoff_start_week = 16 where id = $1", [f.leagueId]);
    await assert.rejects(
      () => db.q("select public.generate_playoffs($1)", [f.leagueId]),
      /before the playoffs start/,
    );
  });
});
