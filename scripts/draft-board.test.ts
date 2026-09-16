/**
 * The draft board: who is in the pool, and what autopick reaches for.
 *
 * Two things here are easy to get wrong in ways nobody notices until
 * draft night. A queue with target rounds has to skip a player who is
 * not due yet *and still pick somebody*, rather than falling through to
 * nothing; and the pool has to be the positions a fantasy league
 * rosters, because the moment an individual guard is draftable the
 * board is two thousand names deep.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, type TestDb } from "./lib/test-db.ts";
import {
  SEASON,
  buildLeague,
  giveStats,
  makePlayer,
  ownerOf,
  type Fixture,
} from "./lib/fixtures.ts";

let db: TestDb;

before(async () => {
  db = await createTestDb();
});

after(async () => {
  await db.close();
});

/** A league with a live draft, and the id of that draft. */
async function liveDraft(name: string): Promise<{ f: Fixture; draftId: string }> {
  const f = await buildLeague(db, name);
  await db.actAs(f.commish);

  const d = await db.one<{ generate_draft: string }>(
    "select public.generate_draft($1) as generate_draft",
    [f.leagueId],
  );
  await db.q("update public.drafts set status = 'live' where id = $1", [
    d.generate_draft,
  ]);

  return { f, draftId: d.generate_draft };
}

/** Expires the clock, which is the only state autopick will act on. */
async function expireClock(draftId: string) {
  await db.q(
    "update public.drafts set pick_deadline = now() - interval '1 minute' where id = $1",
    [draftId],
  );
}

async function teamOnClock(draftId: string): Promise<string> {
  const row = await db.one<{ team_id: string }>(
    `select p.team_id from public.draft_picks p
     join public.drafts d on d.id = p.draft_id
     where p.draft_id = $1 and p.pick_number = d.current_pick_number`,
    [draftId],
  );
  return row.team_id;
}

describe("the draft queue's target rounds", () => {
  test("a player wanted in a later round is not taken yet", async () => {
    const { f, draftId } = await liveDraft("queue-round-later");

    // A sleeper the manager wants in round seven, and somebody better
    // available to take instead.
    const sleeper = await makePlayer(db, "Q_SLEEP", "Late Sleeper", "WR");
    const obvious = await makePlayer(db, "Q_OBVIOUS", "Obvious Pick", "RB");

    await db.q(
      `insert into public.player_week_scores
         (league_id, player_id, season, week, points, breakdown, is_final)
       values ($1, $2, $3, 1, 300, '{}'::jsonb, true)`,
      [f.leagueId, obvious, SEASON],
    );

    const team = await teamOnClock(draftId);
    await db.q(
      `insert into public.draft_queue (team_id, player_id, rank, target_round)
       values ($1, $2, 1, 7)`,
      [team, sleeper],
    );

    await expireClock(draftId);
    await db.q("select public.autopick($1)", [draftId]);

    const pick = await db.one<{ player_id: string | null }>(
      "select player_id from public.draft_picks where draft_id = $1 and pick_number = 1",
      [draftId],
    );

    assert.notEqual(
      pick.player_id,
      sleeper,
      "round seven had not arrived, so the sleeper is still there",
    );
    assert.equal(
      pick.player_id,
      obvious,
      "and autopick fell through to the best available rather than to nobody",
    );
  });

  test("once the round arrives, the queue is honoured", async () => {
    const { f, draftId } = await liveDraft("queue-round-due");

    const wanted = await makePlayer(db, "Q_WANTED", "Wanted Now", "WR");
    const better = await makePlayer(db, "Q_BETTER", "Higher Scorer", "RB");

    // The queued player is deliberately the worse of the two, so taking
    // him can only be the queue's doing.
    await db.q(
      `insert into public.player_week_scores
         (league_id, player_id, season, week, points, breakdown, is_final)
       values ($1, $2, $3, 1, 400, '{}'::jsonb, true)`,
      [f.leagueId, better, SEASON],
    );

    const team = await teamOnClock(draftId);
    await db.q(
      `insert into public.draft_queue (team_id, player_id, rank, target_round)
       values ($1, $2, 1, 1)`,
      [team, wanted],
    );

    await expireClock(draftId);
    await db.q("select public.autopick($1)", [draftId]);

    const pick = await db.one<{ player_id: string | null }>(
      "select player_id from public.draft_picks where draft_id = $1 and pick_number = 1",
      [draftId],
    );
    assert.equal(pick.player_id, wanted, "round one, and he was due in round one");
  });

  test("a queue entry with no round set is due in every round", async () => {
    const { f, draftId } = await liveDraft("queue-round-any");

    const wanted = await makePlayer(db, "Q_ANY", "Any Round", "TE");
    const better = await makePlayer(db, "Q_ANY_BETTER", "Better Any", "RB");
    await db.q(
      `insert into public.player_week_scores
         (league_id, player_id, season, week, points, breakdown, is_final)
       values ($1, $2, $3, 1, 500, '{}'::jsonb, true)`,
      [f.leagueId, better, SEASON],
    );

    const team = await teamOnClock(draftId);
    await db.q(
      "insert into public.draft_queue (team_id, player_id, rank) values ($1, $2, 1)",
      [team, wanted],
    );

    await expireClock(draftId);
    await db.q("select public.autopick($1)", [draftId]);

    const pick = await db.one<{ player_id: string | null }>(
      "select player_id from public.draft_picks where draft_id = $1 and pick_number = 1",
      [draftId],
    );
    assert.equal(pick.player_id, wanted);
  });
});

/**
 * Leaves exactly one player carrying an ADP and one carrying a season
 * projection, among the players these two suites invent.
 *
 * Scoped by id suffix so it only ever touches this file's own fixtures,
 * never the pool or scoring tests further down.
 */
async function isolateFixture(adpId: string, projId: string) {
  await db.q(
    `update public.nfl_players set adp = null, adp_rank = null
      where right(id, 4) = '_ADP' and id <> $1`,
    [adpId],
  );
  await db.q(
    `delete from public.player_season_projections
      where right(player_id, 5) = '_PROJ' and player_id <> $1`,
    [projId],
  );
}

describe("each manager's own autodraft logic", () => {
  /**
   * Three players with deliberately opposite credentials, so which one
   * autopick takes says unambiguously which rule it applied.
   *
   *   BY_ADP        -- first off the board, scored nothing, projected nothing
   *   BY_LAST_YEAR  -- no ADP at all, but 300 points last season
   *   BY_PROJECTION -- no ADP, no history, 400 projected points
   */
  async function threeWays(name: string) {
    const { f, draftId } = await liveDraft(name);

    const adp = await makePlayer(db, `${name}_ADP`, "First Off The Board", "WR");
    const last = await makePlayer(db, `${name}_LAST`, "Last Year Hero", "RB");
    const proj = await makePlayer(db, `${name}_PROJ`, "This Year Breakout", "TE");

    /*
     * nfl_players is shared by every test in this file, and a player
     * invented for an earlier league is still free in this one. Without
     * clearing the previous fixture's numbers the three strategies end
     * up tied against each other's leftovers, and which one wins is
     * whatever the planner felt like.
     */
    await isolateFixture(adp, proj);
    await db.q("update public.nfl_players set adp = 1.1, adp_rank = 1 where id = $1", [adp]);

    await db.q(
      `insert into public.player_week_scores
         (league_id, player_id, season, week, points, breakdown, is_final)
       values ($1, $2, $3, 1, 300, '{}'::jsonb, true)`,
      [f.leagueId, last, SEASON],
    );

    // A projection is a stat line, so it has to be scored by the
    // league's own rules to become points -- 4000 receiving yards at
    // the default 0.1 a yard is 400.
    await db.q(
      `insert into public.player_season_projections (player_id, season, stats)
       values ($1, $2, '{"receiving_yards": 4000}'::jsonb)
       on conflict (player_id, season) do update set stats = excluded.stats`,
      [proj, SEASON],
    );

    return { f, draftId, adp, last, proj };
  }

  async function pickWith(strategy: string, name: string) {
    const { draftId, adp, last, proj } = await threeWays(name);
    const team = await teamOnClock(draftId);

    await db.q("update public.teams set autodraft_strategy = $1 where id = $2", [
      strategy,
      team,
    ]);

    await expireClock(draftId);
    await db.q("select public.autopick($1)", [draftId]);

    const pick = await db.one<{ player_id: string | null }>(
      "select player_id from public.draft_picks where draft_id = $1 and pick_number = 1",
      [draftId],
    );
    return { picked: pick.player_id, adp, last, proj };
  }

  test("by ADP takes the man the room is drafting first", async () => {
    const r = await pickWith("adp", "auto_adp");
    assert.equal(r.picked, r.adp);
  });

  test("by last season takes the man who actually scored", async () => {
    const r = await pickWith("last_season", "auto_last");
    assert.equal(r.picked, r.last);
  });

  test("by projection takes the man this year is expected from", async () => {
    const r = await pickWith("projection", "auto_proj");
    assert.equal(r.picked, r.proj);
  });

  test("the queue still beats the strategy", async () => {
    const { draftId, adp, proj } = await threeWays("auto_queue_wins");
    const team = await teamOnClock(draftId);

    // Set to ADP, which would take somebody else entirely.
    await db.q(
      "update public.teams set autodraft_strategy = 'adp' where id = $1",
      [team],
    );
    await db.q(
      "insert into public.draft_queue (team_id, player_id, rank) values ($1, $2, 1)",
      [team, proj],
    );

    await expireClock(draftId);
    await db.q("select public.autopick($1)", [draftId]);

    const pick = await db.one<{ player_id: string | null }>(
      "select player_id from public.draft_picks where draft_id = $1 and pick_number = 1",
      [draftId],
    );
    assert.equal(pick.player_id, proj, "the queue is the manager speaking");
    assert.notEqual(pick.player_id, adp);
  });

  test("a strategy that says nothing about anybody still picks", async () => {
    // Nobody has an ADP, and the team is set to draft by it. Falling
    // through to nothing would stall the whole draft on one dead clock.
    const { f, draftId } = await liveDraft("auto_no_signal");
    const only = await makePlayer(db, "AUTO_ONLY", "Only Man Left", "WR");
    await db.q(
      `insert into public.player_week_scores
         (league_id, player_id, season, week, points, breakdown, is_final)
       values ($1, $2, $3, 1, 10, '{}'::jsonb, true)`,
      [f.leagueId, only, SEASON],
    );

    const team = await teamOnClock(draftId);
    await db.q(
      "update public.teams set autodraft_strategy = 'adp' where id = $1",
      [team],
    );

    await expireClock(draftId);
    await db.q("select public.autopick($1)", [draftId]);

    const pick = await db.one<{ player_id: string | null }>(
      "select player_id from public.draft_picks where draft_id = $1 and pick_number = 1",
      [draftId],
    );
    assert.ok(pick.player_id !== null, "somebody was taken");
  });

  test("nothing but 'adp', 'last_season' or 'projection' can be stored", async () => {
    const f = await buildLeague(db, "auto_bad_strategy");
    await assert.rejects(
      db.q("update public.teams set autodraft_strategy = 'vibes' where id = $1", [
        f.teamIds[0],
      ]),
    );
  });
});

describe("what autopick would do, asked before the clock runs out", () => {
  test("it agrees with what autopick then actually does", async () => {
    const { f, draftId } = await threeWaysFixture("preview_agrees");

    const team = await teamOnClock(draftId);
    const round = await db.one<{ round: number }>(
      `select p.round from public.draft_picks p
       join public.drafts d on d.id = p.draft_id
       where p.draft_id = $1 and p.pick_number = d.current_pick_number`,
      [draftId],
    );

    await db.actAs(await ownerOf(db, team));
    const preview = await db.one<{ autopick_candidate: string | null }>(
      "select public.autopick_candidate($1, $2, $3) as autopick_candidate",
      [draftId, team, round.round],
    );

    await db.actAs(f.commish);
    await expireClock(draftId);
    await db.q("select public.autopick($1)", [draftId]);

    const pick = await db.one<{ player_id: string | null }>(
      "select player_id from public.draft_picks where draft_id = $1 and pick_number = 1",
      [draftId],
    );

    assert.ok(preview.autopick_candidate, "the preview named somebody");
    assert.equal(
      pick.player_id,
      preview.autopick_candidate,
      "and that is who was taken",
    );
  });

  test("a rival's queue stays a rival's business", async () => {
    const { f, draftId } = await threeWaysFixture("preview_private");

    const team = await teamOnClock(draftId);
    await db.q(
      "insert into public.draft_queue (team_id, player_id, rank) values ($1, $2, 1)",
      [team, `preview_private_PROJ`],
    );

    // Somebody in the league who does not own the team on the clock.
    const rival = f.teamIds.find((id) => id !== team)!;
    await db.actAs(await ownerOf(db, rival));

    const answer = await db.one<{ autopick_candidate: string | null }>(
      "select public.autopick_candidate($1, $2, 1) as autopick_candidate",
      [draftId, team],
    );

    assert.equal(
      answer.autopick_candidate,
      null,
      "asking about somebody else's team tells you nothing",
    );

    await db.actAs(f.commish);
  });

  /** The same three-way fixture, reachable from this describe block. */
  async function threeWaysFixture(name: string) {
    const { f, draftId } = await liveDraft(name);

    await makePlayer(db, `${name}_ADP`, "First Off The Board", "WR");
    await makePlayer(db, `${name}_PROJ`, "This Year Breakout", "TE");
    await isolateFixture(`${name}_ADP`, `${name}_PROJ`);
    await db.q(
      "update public.nfl_players set adp = 1.1, adp_rank = 1 where id = $1",
      [`${name}_ADP`],
    );
    await db.q(
      `insert into public.player_season_projections (player_id, season, stats)
       values ($1, $2, '{"receiving_yards": 4000}'::jsonb)
       on conflict (player_id, season) do update set stats = excluded.stats`,
      [`${name}_PROJ`, SEASON],
    );

    return { f, draftId };
  }
});

describe("who is in the player pool", () => {
  test("individual defenders and linemen are not, their units are", async () => {
    const cases: [string, string, boolean][] = [
      // id, position, should a fantasy league be able to roster him?
      ["POOL_QB", "QB", true],
      ["POOL_RB", "RB", true],
      ["POOL_FB", "FB", true],
      ["POOL_K", "K", true],
      ["POOL_P", "P", true],
      ["POOL_LB", "LB", false],
      ["POOL_CB", "CB", false],
      ["POOL_EDGE", "EDGE", false],
      ["POOL_S", "S", false],
      // A real guard, tackle or centre -- including one nflverse simply
      // labels 'OL', which is why the unit is told apart by its id.
      ["POOL_G", "G", false],
      ["POOL_T", "T", false],
      ["POOL_C", "C", false],
      ["POOL_OL_MAN", "OL", false],
      // The three pseudo-players.
      ["DST_KC", "DEF", true],
      ["OL_KC", "OL", true],
      ["HC_KC", "HC", true],
    ];

    for (const [id, position, expected] of cases) {
      const row = await db.one<{ ok: boolean }>(
        "select public.is_fantasy_player($1, $2) as ok",
        [id, position],
      );
      assert.equal(
        row.ok,
        expected,
        `${id} (${position}) should ${expected ? "" : "not "}be rosterable`,
      );
    }
  });

  test("the pool leaves defenders out and keeps the team units in", async () => {
    const f = await buildLeague(db, "pool-positions");
    await db.actAs(f.commish);

    await makePlayer(db, "PP_WR", "Pool Receiver", "WR");
    await makePlayer(db, "PP_LB", "Pool Linebacker", "LB");
    await makePlayer(db, "PP_GUARD", "Pool Guard", "G");

    const rows = await db.q<{ player_id: string }>(
      `select player_id from public.league_player_pool(
         $1, null, null, 'all', 'points', 500, 0)`,
      [f.leagueId],
    );
    const ids = new Set(rows.map((r) => r.player_id));

    assert.ok(ids.has("PP_WR"), "a receiver is in the pool");
    assert.ok(!ids.has("PP_LB"), "a linebacker is not");
    assert.ok(!ids.has("PP_GUARD"), "nor is a guard");
    assert.ok(ids.has("DST_KC"), "the Kansas City defense is");
    assert.ok(ids.has("OL_KC"), "and so is the Kansas City offensive line");
  });

  test("'FLEX' filters to whatever this league's flex slots take", async () => {
    const f = await buildLeague(db, "pool-flex");
    await db.actAs(f.commish);

    await makePlayer(db, "FX_RB", "Flex Back", "RB");
    await makePlayer(db, "FX_WR", "Flex Receiver", "WR");
    await makePlayer(db, "FX_TE", "Flex End", "TE");
    await makePlayer(db, "FX_QB", "Flex Passer", "QB");
    await makePlayer(db, "FX_K", "Flex Kicker", "K");

    const rows = await db.q<{ player_id: string; pos: string }>(
      `select player_id, pos from public.league_player_pool(
         $1, null, 'FLEX', 'all', 'points', 500, 0)`,
      [f.leagueId],
    );
    const positions = new Set(rows.map((r) => r.pos));

    // The default roster's only multi-position starter is W/R/T.
    assert.deepEqual(
      [...positions].sort(),
      ["RB", "TE", "WR"],
      "flex is the flex slot's own eligibility, nothing else",
    );
  });

  test("sorting by ADP puts the earliest pick first and the unranked last", async () => {
    const f = await buildLeague(db, "pool-adp");
    await db.actAs(f.commish);

    await makePlayer(db, "ADP_FIRST", "First Overall", "RB");
    await makePlayer(db, "ADP_LATE", "Late Round", "WR");
    await makePlayer(db, "ADP_NONE", "Undrafted", "TE");

    await db.asSuperuser(async () => {
      await db.q("update public.nfl_players set adp = 1.2 where id = 'ADP_FIRST'");
      await db.q("update public.nfl_players set adp = 90.4 where id = 'ADP_LATE'");
    });

    const rows = await db.q<{ player_id: string }>(
      `select player_id from public.league_player_pool(
         $1, 'ADP_', null, 'all', 'adp', 500, 0)`,
      [f.leagueId],
    );

    // search_name is built from the display name, so search on that.
    const ranked = await db.q<{ player_id: string }>(
      `select player_id from public.league_player_pool(
         $1, null, null, 'all', 'adp', 500, 0)`,
      [f.leagueId],
    );
    const order = ranked.map((r) => r.player_id);

    assert.ok(rows.length >= 0);
    assert.ok(
      order.indexOf("ADP_FIRST") < order.indexOf("ADP_LATE"),
      "1.2 comes before 90.4",
    );
    assert.ok(
      order.indexOf("ADP_LATE") < order.indexOf("ADP_NONE"),
      "and anybody with no ADP sorts behind both, not in front",
    );
  });
});

describe("writing ADP", () => {
  test("a partial upsert cannot work, which is why there is an RPC", async () => {
    await makePlayer(db, "ADPW_EXISTS", "Already Here", "RB");

    // Exactly what supabase-js emits for
    // upsert({ id, adp }, { onConflict: "id" }). Postgres builds and
    // validates the proposed row before it looks for a conflict, so the
    // missing full_name fails NOT NULL even though this player plainly
    // already exists. If this ever starts passing, set_player_adp could
    // go back to being an upsert.
    await assert.rejects(
      () =>
        db.q(
          `insert into public.nfl_players (id, adp) values ('ADPW_EXISTS', 1.5)
           on conflict (id) do update set adp = excluded.adp`,
        ),
      /full_name/,
      "a partial upsert trips NOT NULL on a row that already exists",
    );
  });

  test("set_player_adp updates the named players", async () => {
    await makePlayer(db, "ADPW_A", "Adp A", "RB");
    await makePlayer(db, "ADPW_B", "Adp B", "WR");

    const n = await db.one<{ set_player_adp: number }>(
      "select public.set_player_adp($1::jsonb) as set_player_adp",
      [
        JSON.stringify([
          { id: "ADPW_A", adp: 1.5, adp_rank: 1, adp_source: "espn" },
          { id: "ADPW_B", adp: 22.25, adp_rank: 2, adp_source: "espn" },
        ]),
      ],
    );
    assert.equal(Number(n.set_player_adp), 2);

    const rows = await db.q<{ id: string; adp: string; adp_rank: number }>(
      "select id, adp, adp_rank from public.nfl_players where id in ('ADPW_A','ADPW_B') order by id",
    );
    assert.equal(Number(rows[0].adp), 1.5);
    assert.equal(rows[0].adp_rank, 1);
    assert.equal(Number(rows[1].adp), 22.25);
  });

  test("a player who drops off the board loses his stale number", async () => {
    await makePlayer(db, "ADPW_GONE", "Fell Off", "TE");

    await db.q("select public.set_player_adp($1::jsonb)", [
      JSON.stringify([
        { id: "ADPW_GONE", adp: 10, adp_rank: 1, adp_source: "espn" },
      ]),
    ]);

    // A later run that no longer mentions him.
    await db.q("select public.set_player_adp($1::jsonb)", [
      JSON.stringify([
        { id: "ADPW_A", adp: 1, adp_rank: 1, adp_source: "espn" },
      ]),
    ]);

    const row = await db.one<{ adp: string | null; adp_rank: number | null }>(
      "select adp, adp_rank from public.nfl_players where id = 'ADPW_GONE'",
    );
    assert.equal(row.adp, null, "a stale ADP would still sort him near the top");
    assert.equal(row.adp_rank, null);
  });

  test("nobody but the ingestion jobs may call it", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.q("select set_config('request.jwt.claims', $1, false)", [
        JSON.stringify({ role }),
      ]);

      await assert.rejects(
        () =>
          db.q("select public.set_player_adp($1::jsonb)", [
            JSON.stringify([
              { id: "ADPW_A", adp: 1, adp_rank: 1, adp_source: "espn" },
            ]),
          ]),
        /Only the ingestion jobs/,
        `${role} is refused`,
      );
    }

    await db.q("select set_config('request.jwt.claims', '', false)");
  });
});

describe("an offensive line as a draftable, scorable unit", () => {
  test("OL_<abbr> scores through the same path as everybody else", async () => {
    const f = await buildLeague(db, "oline-scoring");
    await db.actAs(f.commish);

    // The scoring engine matches stat keys against the league's rules
    // and multiplies. Nothing anywhere knows that an offensive line is
    // special, which is the whole reason it can be one.
    await giveStats(db, "OL_KC", 1, {
      ol_sacks_allowed: 2,
      ol_rushing_yards: 140,
      ol_rushing_tds: 1,
      ol_sacks_allowed_1_2: 1,
      ol_rush_100_bonus: 1,
    });

    await db.q("select public.recompute_week_scores($1, $2, $3)", [
      f.leagueId,
      SEASON,
      1,
    ]);

    const row = await db.one<{ points: string }>(
      `select points from public.player_week_scores
       where league_id = $1 and player_id = 'OL_KC'`,
      [f.leagueId],
    );

    // 2 sacks at -1, 140 yards at 0.05, a rushing TD at 2, the 1-2 sack
    // tier at 2, and the 100-yard bonus at 1.
    assert.equal(Number(row.points), -2 + 7 + 2 + 2 + 1);
  });

  test("an offensive line can be drafted like a player", async () => {
    const { draftId } = await liveDraft("oline-draft");

    await db.q("select public.make_draft_pick($1, $2)", [draftId, "OL_KC"]);

    const rostered = await db.one<{ n: number }>(
      `select count(*)::int as n from public.roster_players
       where player_id = 'OL_KC' and dropped_at is null`,
    );
    assert.equal(rostered.n, 1, "and lands on a roster, not in a special case");
  });
});

describe("playoff rounds with a field size and byes", () => {
  /** Six teams, each with a distinct record so seeding is deterministic. */
  async function sixTeamLeague(name: string): Promise<Fixture> {
    const f = await buildLeague(db, name);
    await db.actAs(f.commish);
    await db.q("select public.set_team_count($1, 6)", [f.leagueId]);

    const teams = await db.q<{ id: string }>(
      "select id from public.teams where league_id = $1 order by slot_number",
      [f.leagueId],
    );

    await db.q(
      "delete from public.matchups where league_id = $1 and is_playoff = false",
      [f.leagueId],
    );

    for (let i = 0; i < teams.length; i++) {
      const wins = teams.length - i;
      for (let w = 0; w < wins; w++) {
        const opponent = teams[(i + w + 1) % teams.length].id;
        if (opponent === teams[i].id) continue;
        await db.q(
          `insert into public.matchups
             (league_id, season, week, home_team_id, away_team_id,
              home_score, away_score, status, is_playoff)
           values ($1, $2, $3, $4, $5, 100, 50, 'final', false)
           on conflict (league_id, season, week, home_team_id) do nothing`,
          [f.leagueId, SEASON, i * 20 + w + 1, teams[i].id, opponent],
        );
      }
    }

    return f;
  }

  test("six teams with the top two on a bye is two games and two byes", async () => {
    const f = await sixTeamLeague("bracket-six-two-byes");
    await db.q(
      `update public.leagues
         set playoff_teams = 6, playoff_start_week = 15 where id = $1`,
      [f.leagueId],
    );
    await db.q(
      `insert into public.league_playoff_rounds
         (league_id, bracket, round_index, weeks, teams, byes)
       values ($1, 'winners', 1, 1, 6, 2)`,
      [f.leagueId],
    );

    await db.q("select public.generate_playoffs($1)", [f.leagueId]);

    const games = await db.q<{ away_team_id: string | null; playoff_round: string }>(
      `select away_team_id, playoff_round from public.matchups
       where league_id = $1 and is_playoff`,
      [f.leagueId],
    );

    const byes = games.filter((g) => g.away_team_id === null);
    const played = games.filter((g) => g.away_team_id !== null);

    assert.equal(byes.length, 2, "the top two seeds sit it out");
    assert.equal(played.length, 2, "the other four pair off");
  });

  test("the byes go to the top seeds, not to whoever comes first", async () => {
    const f = await sixTeamLeague("bracket-bye-seeding");
    await db.q(
      `update public.leagues
         set playoff_teams = 6, playoff_start_week = 15 where id = $1`,
      [f.leagueId],
    );
    await db.q(
      `insert into public.league_playoff_rounds
         (league_id, bracket, round_index, weeks, teams, byes)
       values ($1, 'winners', 1, 1, 6, 2)`,
      [f.leagueId],
    );
    await db.q("select public.generate_playoffs($1)", [f.leagueId]);

    const byeSeeds = await db.q<{ seed: number }>(
      `select s.seed
       from public.matchups m
       join public.playoff_seeds s
         on s.team_id = m.home_team_id and s.league_id = m.league_id
        and s.season = m.season
       where m.league_id = $1 and m.is_playoff and m.away_team_id is null
       order by s.seed`,
      [f.leagueId],
    );

    assert.deepEqual(
      byeSeeds.map((r) => r.seed),
      [1, 2],
      "seeds one and two",
    );
  });

  test("an odd remaining field gets one more bye rather than half a game", async () => {
    // Five playing with one bye would leave four -- fine. Five with two
    // byes leaves three, which cannot pair off, so a third bye is added.
    const cases: [field: number, requested: number, expected: number][] = [
      [6, 2, 2],
      [6, 1, 2],
      [6, 0, 0],
      [5, 1, 1],
      [5, 0, 1],
      // Three byes out of four would leave one team playing nobody, and
      // four byes would leave a round with no games in it, so it settles
      // on two: one game, two seeds rested.
      [4, 3, 2],
      [4, 9, 2],
      [2, 1, 0],
      [2, 0, 0],
    ];

    for (const [field, requested, expected] of cases) {
      const row = await db.one<{ byes: number }>(
        "select public.playoff_round_byes($1, $2) as byes",
        [field, requested],
      );
      assert.equal(
        row.byes,
        expected,
        `a field of ${field} asking for ${requested} byes`,
      );
      assert.equal(
        (field - row.byes) % 2,
        0,
        `a field of ${field} must leave an even number playing`,
      );
    }
  });

  test("a smaller field in a later round eliminates the lowest seeds", async () => {
    const f = await sixTeamLeague("bracket-narrowing");
    await db.q(
      `update public.leagues
         set playoff_teams = 6, playoff_start_week = 15, current_week = 15
       where id = $1`,
      [f.leagueId],
    );
    // Six play, then only two -- so the four who win round one are cut
    // to the best two rather than playing a semi-final.
    await db.q(
      `insert into public.league_playoff_rounds
         (league_id, bracket, round_index, weeks, teams, byes)
       values ($1, 'winners', 1, 1, 6, 2), ($1, 'winners', 2, 1, 2, 0)`,
      [f.leagueId],
    );
    await db.q("select public.generate_playoffs($1)", [f.leagueId]);
    await db.q(
      `update public.matchups set status = 'final'
       where league_id = $1 and is_playoff and week = 15`,
      [f.leagueId],
    );

    await db.q("select public.advance_playoffs($1, 15)", [f.leagueId]);

    const next = await db.q<{ away_team_id: string | null }>(
      `select away_team_id from public.matchups
       where league_id = $1 and is_playoff and week = 16`,
      [f.leagueId],
    );

    assert.equal(next.length, 1, "one game, not two");
    assert.ok(next[0].away_team_id !== null, "and it is a game, not a bye");
  });
});
