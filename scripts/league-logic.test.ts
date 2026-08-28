/**
 * Functional tests for the league logic that lives in Postgres.
 *
 *   npm test
 *
 * These run against a real Postgres (PGlite, in memory) with the actual
 * migrations applied, so they exercise the same PL/pgSQL that Supabase
 * will run. RLS is not covered here -- PGlite runs as superuser, which
 * bypasses policies -- so these test the rules inside the SECURITY
 * DEFINER functions.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, type TestDb } from "./lib/test-db.ts";
import {
  SEASON,
  buildLeague,
  giveStats,
  makePlayer,
} from "./lib/fixtures.ts";

let db: TestDb;

/** Bound to this suite's database so the tests read without the extra arg. */
const league = (name: string, overrides?: string) =>
  buildLeague(db, name, overrides);
const player = (id: string, name: string, position: string, team?: string) =>
  makePlayer(db, id, name, position, team);
const stats = (
  playerId: string,
  week: number,
  values: Record<string, number>,
  source?: "live" | "final",
) => giveStats(db, playerId, week, values, source);

before(async () => {
  db = await createTestDb();
});

after(async () => {
  await db.close();
});

// ---------------------------------------------------------------------------

describe("league setup", () => {
  test("a new league gets default roster slots and scoring rules", async () => {
    const f = await league("setup");

    const slots = await db.q<{ slot_key: string; count: number }>(
      "select slot_key, count from public.roster_slots where league_id = $1 order by order_index",
      [f.leagueId],
    );
    assert.deepEqual(
      slots.map((s) => s.slot_key),
      ["QB", "RB", "WR", "TE", "FLEX", "K", "DEF", "BN", "IR"],
    );

    const { n } = await db.one<{ n: number }>(
      "select count(*)::int as n from public.league_scoring_rules where league_id = $1",
      [f.leagueId],
    );
    // Every scorable stat in the catalog gets a rule row.
    assert.ok(n > 130, `expected the full catalog to be seeded, got ${n}`);

    const ppr = await db.one<{ points: string }>(
      "select points from public.league_scoring_rules where league_id = $1 and stat_key = 'receptions'",
      [f.leagueId],
    );
    assert.equal(Number(ppr.points), 1);
  });

  test("joining is idempotent and does not create a second team", async () => {
    const f = await league("idempotent");
    const code = await db.one<{ join_code: string }>(
      "select join_code from public.leagues where id = $1",
      [f.leagueId],
    );

    await db.actAs(f.managers[0]);
    await db.q("select public.join_league($1, $2)", [code.join_code, "Different Name"]);

    const { n } = await db.one<{ n: number }>(
      "select count(*)::int as n from public.teams where league_id = $1",
      [f.leagueId],
    );
    assert.equal(n, 4);
  });

  test("teams start with the league FAAB budget", async () => {
    const f = await league("faab-budget", "faab_budget = 250");
    // The budget default applies to teams created after the change.
    await db.actAs(f.commish);
    const code = await db.one<{ join_code: string }>(
      "select join_code from public.leagues where id = $1",
      [f.leagueId],
    );
    const late = await db.createUser("late-faab@example.com");
    await db.actAs(late);
    const t = await db.one<{ join_league: string }>(
      "select public.join_league($1, $2) as join_league",
      [code.join_code, "Late Team"],
    );
    const team = await db.one<{ faab_remaining: number }>(
      "select faab_remaining from public.teams where id = $1",
      [t.join_league],
    );
    assert.equal(team.faab_remaining, 250);
  });
});

// ---------------------------------------------------------------------------

describe("scoring engine", () => {
  test("applies points-per-unit from the league rule table", async () => {
    const f = await league("scoring");
    const pid = await player("SCORE_WR", "Test Receiver", "WR");

    // Default rules: 0.1/rec yard, 6/rec TD, 1/reception.
    await stats(pid, 1, {
      receptions: 8,
      receiving_yards: 120,
      receiving_tds: 2,
      targets: 11,
    });

    await db.q("select public.recompute_week_scores($1, $2, $3)", [f.leagueId, SEASON, 1]);

    const row = await db.one<{ points: string; breakdown: Record<string, { points: number }> }>(
      `select points, breakdown from public.player_week_scores
       where league_id = $1 and player_id = $2 and week = 1`,
      [f.leagueId, pid],
    );

    // 8 + 12 + 12 = 32. Targets are in the catalog but default to 0.
    assert.equal(Number(row.points), 32);
    assert.ok(!("targets" in row.breakdown), "zero-point stats stay out of the breakdown");
  });

  test("a scoring change re-scores the same stat line", async () => {
    const f = await league("rescoring");
    const pid = await player("RESCORE_WR", "Rescore Receiver", "WR");
    await stats(pid, 1, { receptions: 10, receiving_yards: 100 });

    await db.q("select public.recompute_week_scores($1, $2, $3)", [f.leagueId, SEASON, 1]);
    let row = await db.one<{ points: string }>(
      "select points from public.player_week_scores where league_id = $1 and player_id = $2",
      [f.leagueId, pid],
    );
    assert.equal(Number(row.points), 20); // 10 rec + 10 yards

    // Switch to half PPR and turn targets on.
    await db.q(
      "update public.league_scoring_rules set points = 0.5 where league_id = $1 and stat_key = 'receptions'",
      [f.leagueId],
    );
    await db.q("select public.recompute_week_scores($1, $2, $3)", [f.leagueId, SEASON, 1]);

    row = await db.one<{ points: string }>(
      "select points from public.player_week_scores where league_id = $1 and player_id = $2",
      [f.leagueId, pid],
    );
    assert.equal(Number(row.points), 15);
  });

  test("scores an obscure stat once the commissioner turns it on", async () => {
    const f = await league("obscure");
    const pid = await player("YAC_WR", "YAC Merchant", "WR");
    await stats(pid, 1, {
      receptions: 5,
      receiving_yards: 60,
      receiving_yards_after_catch: 55,
      rush_broken_tackles: 3,
    });

    await db.q(
      `update public.league_scoring_rules set points = 0.2
       where league_id = $1 and stat_key = 'receiving_yards_after_catch'`,
      [f.leagueId],
    );
    await db.q(
      `update public.league_scoring_rules set points = 2
       where league_id = $1 and stat_key = 'rush_broken_tackles'`,
      [f.leagueId],
    );
    await db.q("select public.recompute_week_scores($1, $2, $3)", [f.leagueId, SEASON, 1]);

    const row = await db.one<{ points: string }>(
      "select points from public.player_week_scores where league_id = $1 and player_id = $2",
      [f.leagueId, pid],
    );
    // 5 rec + 6 yds + 11 YAC + 6 broken tackles
    assert.equal(Number(row.points), 28);
  });

  test("position-restricted rules only apply to that position", async () => {
    const f = await league("positional");
    const wr = await player("POS_WR", "Positional WR", "WR");
    const te = await player("POS_TE", "Positional TE", "TE");

    await stats(wr, 1, { receptions: 5 });
    await stats(te, 1, { receptions: 5 });

    // TE premium: receptions worth 1.5 for tight ends only.
    await db.q(
      `insert into public.league_scoring_rules (league_id, stat_key, points, positions)
       values ($1, 'receptions', 1.5, array['TE'])
       on conflict (league_id, stat_key)
       do update set points = 1.5, positions = array['TE']`,
      [f.leagueId],
    );
    await db.q("select public.recompute_week_scores($1, $2, $3)", [f.leagueId, SEASON, 1]);

    const teRow = await db.one<{ points: string }>(
      "select points from public.player_week_scores where league_id = $1 and player_id = $2",
      [f.leagueId, te],
    );
    assert.equal(Number(teRow.points), 7.5);

    const wrRows = await db.q<{ points: string }>(
      "select points from public.player_week_scores where league_id = $1 and player_id = $2",
      [f.leagueId, wr],
    );
    assert.equal(wrRows.length, 0, "the WR no longer matches any non-zero rule");
  });

  test("team defenses score through the same path as players", async () => {
    const f = await league("dst");
    await stats("DST_KC", 1, {
      dst_sacks: 4,
      dst_interceptions: 2,
      dst_pa_1_6: 1,
      dst_points_allowed: 3,
    });
    await db.q("select public.recompute_week_scores($1, $2, $3)", [f.leagueId, SEASON, 1]);

    const row = await db.one<{ points: string }>(
      "select points from public.player_week_scores where league_id = $1 and player_id = 'DST_KC'",
      [f.leagueId],
    );
    // 4 sacks + 2*2 INTs + 7 for the 1-6 points-allowed tier
    assert.equal(Number(row.points), 15);
  });

  test("a live stat line is not marked final", async () => {
    const f = await league("liveflag");
    const pid = await player("LIVE_RB", "Live Runner", "RB");
    await stats(pid, 1, { rushing_yards: 50 }, "live");
    await db.q("select public.recompute_week_scores($1, $2, $3)", [f.leagueId, SEASON, 1]);

    const row = await db.one<{ is_final: boolean }>(
      "select is_final from public.player_week_scores where league_id = $1 and player_id = $2",
      [f.leagueId, pid],
    );
    assert.equal(row.is_final, false);
  });
});

// ---------------------------------------------------------------------------

describe("matchups and standings", () => {
  test("starters count toward the matchup score and the bench does not", async () => {
    const f = await league("matchup");
    await db.actAs(f.commish);
    await db.q("select public.generate_schedule($1)", [f.leagueId]);

    const starter = await player("MU_START", "Starter", "WR");
    const benched = await player("MU_BENCH", "Benched", "WR");
    await stats(starter, 1, { receiving_yards: 100 }); // 10 pts
    await stats(benched, 1, { receiving_yards: 200 }); // 20 pts, benched

    const home = f.teamIds[0];
    await db.q(
      `insert into public.lineup_entries (league_id, team_id, season, week, player_id, slot_key)
       values ($1, $2, $3, 1, $4, 'WR'), ($1, $2, $3, 1, $5, 'BN')`,
      [f.leagueId, home, SEASON, starter, benched],
    );

    await db.q("select public.recompute_week_scores($1, $2, $3)", [f.leagueId, SEASON, 1]);

    const m = await db.one<{ home_score: string; away_score: string }>(
      `select home_score, away_score from public.matchups
       where league_id = $1 and week = 1 and (home_team_id = $2 or away_team_id = $2)`,
      [f.leagueId, home],
    );
    const teamScore = Number(m.home_score) || Number(m.away_score);
    assert.equal(teamScore, 10, "only the started WR should count");
  });

  test("the schedule pairs every team each week with no repeats", async () => {
    const f = await league("schedule");
    await db.actAs(f.commish);
    await db.q("select public.generate_schedule($1)", [f.leagueId]);

    const weeks = await db.q<{ week: number; n: number }>(
      `select week, count(*)::int as n from public.matchups
       where league_id = $1 group by week order by week`,
      [f.leagueId],
    );
    assert.equal(weeks.length, 14, "14 regular season weeks by default");
    for (const w of weeks) {
      assert.equal(w.n, 2, `week ${w.week} should have 2 matchups for 4 teams`);
    }

    // Every team appears exactly once a week.
    const dupes = await db.q(
      `select week from (
         select week, home_team_id as t from public.matchups where league_id = $1
         union all
         select week, away_team_id as t from public.matchups where league_id = $1
       ) s
       group by week, t having count(*) > 1`,
      [f.leagueId],
    );
    assert.equal(dupes.length, 0, "no team plays twice in a week");
  });

  test("standings tally wins from finalised matchups", async () => {
    const f = await league("standings");
    await db.actAs(f.commish);
    await db.q("select public.generate_schedule($1)", [f.leagueId]);

    await db.q(
      `update public.matchups set home_score = 100, away_score = 90, status = 'final'
       where league_id = $1 and week = 1`,
      [f.leagueId],
    );

    const rows = await db.q<{ wins: number; losses: number; points_for: string }>(
      "select wins, losses, points_for from public.standings where league_id = $1 order by wins desc",
      [f.leagueId],
    );
    assert.equal(rows.length, 4);
    assert.equal(rows[0].wins, 1);
    assert.equal(rows[0].losses, 0);
    assert.equal(Number(rows[0].points_for), 100);
    assert.equal(rows[3].wins, 0);
    assert.equal(rows[3].losses, 1);
  });
});

// ---------------------------------------------------------------------------

describe("roster moves", () => {
  test("adding a free agent puts him on the roster and logs it", async () => {
    const f = await league("addfa");
    const pid = await player("FA_RB", "Free Agent RB", "RB");

    await db.actAs(f.managers[0]);
    await db.q("select public.add_free_agent($1, $2)", [f.teamIds[1], pid]);

    const roster = await db.q(
      "select 1 from public.roster_players where team_id = $1 and player_id = $2 and dropped_at is null",
      [f.teamIds[1], pid],
    );
    assert.equal(roster.length, 1);

    const tx = await db.one<{ type: string }>(
      "select type from public.transactions where league_id = $1 and player_id = $2",
      [f.leagueId, pid],
    );
    assert.equal(tx.type, "add");
  });

  test("two teams cannot roster the same player", async () => {
    const f = await league("contested");
    const pid = await player("CONTESTED", "Contested Player", "WR");

    await db.actAs(f.managers[0]);
    await db.q("select public.add_free_agent($1, $2)", [f.teamIds[1], pid]);

    await db.actAs(f.managers[1]);
    await assert.rejects(
      () => db.q("select public.add_free_agent($1, $2)", [f.teamIds[2], pid]),
      /already on a roster/,
    );
  });

  test("you cannot add to a team you do not own", async () => {
    const f = await league("notyours");
    const pid = await player("NOTYOURS", "Someone", "WR");

    await db.actAs(f.managers[0]);
    await assert.rejects(
      () => db.q("select public.add_free_agent($1, $2)", [f.teamIds[2], pid]),
      /not your team/,
    );
  });

  test("a dropped player goes on waivers rather than straight back to free agency", async () => {
    const f = await league("dropwaiver");
    const pid = await player("DROPPED", "Dropped Player", "RB");

    await db.actAs(f.managers[0]);
    await db.q("select public.add_free_agent($1, $2)", [f.teamIds[1], pid]);
    await db.q("select public.drop_player($1, $2)", [f.teamIds[1], pid]);

    const held = await db.one<{ on_waivers: boolean }>(
      "select public.player_on_waivers($1, $2) as on_waivers",
      [f.leagueId, pid],
    );
    assert.equal(held.on_waivers, true);

    await db.actAs(f.managers[1]);
    await assert.rejects(
      () => db.q("select public.add_free_agent($1, $2)", [f.teamIds[2], pid]),
      /on waivers/,
    );
  });

  test("a full roster is rejected unless you drop someone", async () => {
    const f = await league("full");
    // Shrink the roster to two slots so the test stays small.
    await db.actAs(f.commish);
    await db.q("delete from public.roster_slots where league_id = $1", [f.leagueId]);
    await db.q(
      `insert into public.roster_slots (league_id, slot_key, label, count, is_starter, order_index)
       values ($1, 'WR', 'WR', 1, true, 10), ($1, 'BN', 'Bench', 1, false, 20)`,
      [f.leagueId],
    );

    const a = await player("FULL_A", "Player A", "WR");
    const b = await player("FULL_B", "Player B", "WR");
    const c = await player("FULL_C", "Player C", "WR");

    await db.actAs(f.managers[0]);
    const team = f.teamIds[1];
    await db.q("select public.add_free_agent($1, $2)", [team, a]);
    await db.q("select public.add_free_agent($1, $2)", [team, b]);

    await assert.rejects(
      () => db.q("select public.add_free_agent($1, $2)", [team, c]),
      /roster is full/,
    );

    // Same add, but paired with a drop, is fine.
    await db.q("select public.add_free_agent($1, $2, $3)", [team, c, a]);
    const { n } = await db.one<{ n: number }>(
      "select public.roster_size($1) as n",
      [team],
    );
    assert.equal(n, 2);
  });

  test("dropping a player clears him from unlocked lineups", async () => {
    const f = await league("dropslineup");
    const pid = await player("LINEUP_DROP", "Lineup Drop", "WR");

    await db.actAs(f.managers[0]);
    const team = f.teamIds[1];
    await db.q("select public.add_free_agent($1, $2)", [team, pid]);
    await db.q(
      `insert into public.lineup_entries (league_id, team_id, season, week, player_id, slot_key)
       values ($1, $2, $3, 1, $4, 'WR')`,
      [f.leagueId, team, SEASON, pid],
    );

    await db.q("select public.drop_player($1, $2)", [team, pid]);

    const left = await db.q(
      "select 1 from public.lineup_entries where team_id = $1 and player_id = $2",
      [team, pid],
    );
    assert.equal(left.length, 0);
  });
});

// ---------------------------------------------------------------------------

describe("waivers", () => {
  async function claim(
    leagueId: string,
    teamId: string,
    playerId: string,
    bid: number,
    dropId?: string,
  ) {
    await db.q(
      `insert into public.waiver_claims
         (league_id, team_id, add_player_id, drop_player_id, bid_amount, season, week)
       values ($1, $2, $3, $4, $5, $6, 1)`,
      [leagueId, teamId, playerId, dropId ?? null, bid, SEASON],
    );
  }

  test("the highest FAAB bid wins and the budget is debited", async () => {
    const f = await league("faab");
    const pid = await player("FAAB_WR", "FAAB Target", "WR");

    await claim(f.leagueId, f.teamIds[1], pid, 15);
    await claim(f.leagueId, f.teamIds[2], pid, 42);
    await claim(f.leagueId, f.teamIds[3], pid, 7);

    await db.actAs(f.commish);
    const { process_waivers } = await db.one<{ process_waivers: number }>(
      "select public.process_waivers($1) as process_waivers",
      [f.leagueId],
    );
    assert.equal(process_waivers, 1);

    const owner = await db.one<{ team_id: string }>(
      "select team_id from public.roster_players where league_id = $1 and player_id = $2",
      [f.leagueId, pid],
    );
    assert.equal(owner.team_id, f.teamIds[2], "the $42 bid should win");

    const winner = await db.one<{ faab_remaining: number }>(
      "select faab_remaining from public.teams where id = $1",
      [f.teamIds[2]],
    );
    assert.equal(winner.faab_remaining, 58, "100 - 42");

    const loser = await db.one<{ faab_remaining: number }>(
      "select faab_remaining from public.teams where id = $1",
      [f.teamIds[1]],
    );
    assert.equal(loser.faab_remaining, 100, "losing bids cost nothing");

    const statuses = await db.q<{ status: string; bid_amount: number }>(
      "select status, bid_amount from public.waiver_claims where league_id = $1 order by bid_amount desc",
      [f.leagueId],
    );
    assert.deepEqual(
      statuses.map((s) => s.status),
      ["won", "lost", "lost"],
    );
  });

  test("a bid over the remaining budget is rejected, not silently honoured", async () => {
    const f = await league("overbid");
    const pid = await player("OVERBID", "Overbid Target", "WR");

    await db.q("update public.teams set faab_remaining = 10 where id = $1", [f.teamIds[1]]);
    await claim(f.leagueId, f.teamIds[1], pid, 80);

    await db.actAs(f.commish);
    await db.q("select public.process_waivers($1)", [f.leagueId]);

    const c = await db.one<{ status: string; result_note: string }>(
      "select status, result_note from public.waiver_claims where league_id = $1",
      [f.leagueId],
    );
    assert.equal(c.status, "invalid");
    assert.match(c.result_note, /FAAB/);

    const team = await db.one<{ faab_remaining: number }>(
      "select faab_remaining from public.teams where id = $1",
      [f.teamIds[1]],
    );
    assert.equal(team.faab_remaining, 10, "budget untouched");
  });

  test("one team winning two players spends both bids", async () => {
    const f = await league("twoclaims");
    const a = await player("TWO_A", "Target A", "WR");
    const b = await player("TWO_B", "Target B", "RB");

    await claim(f.leagueId, f.teamIds[1], a, 30);
    await claim(f.leagueId, f.teamIds[1], b, 20);

    await db.actAs(f.commish);
    await db.q("select public.process_waivers($1)", [f.leagueId]);

    const team = await db.one<{ faab_remaining: number }>(
      "select faab_remaining from public.teams where id = $1",
      [f.teamIds[1]],
    );
    assert.equal(team.faab_remaining, 50, "100 - 30 - 20");
  });

  test("waiver priority mode moves the winner to the back of the order", async () => {
    const f = await league("priority", "waiver_type = 'priority'");
    const pid = await player("PRIO_WR", "Priority Target", "WR");

    // Team at priority 1 should win regardless of bid amount.
    const priorities = await db.q<{ id: string; waiver_priority: number }>(
      "select id, waiver_priority from public.teams where league_id = $1 order by waiver_priority",
      [f.leagueId],
    );
    const first = priorities[0];
    const second = priorities[1];

    await claim(f.leagueId, second.id, pid, 99);
    await claim(f.leagueId, first.id, pid, 0);

    await db.actAs(f.commish);
    await db.q("select public.process_waivers($1)", [f.leagueId]);

    const owner = await db.one<{ team_id: string }>(
      "select team_id from public.roster_players where league_id = $1 and player_id = $2",
      [f.leagueId, pid],
    );
    assert.equal(owner.team_id, first.id, "priority beats a bigger bid in priority mode");

    const after = await db.one<{ waiver_priority: number }>(
      "select waiver_priority from public.teams where id = $1",
      [first.id],
    );
    const max = await db.one<{ m: number }>(
      "select max(waiver_priority) as m from public.teams where league_id = $1",
      [f.leagueId],
    );
    assert.equal(after.waiver_priority, max.m, "winner drops to the back");
  });

  test("a claim on a player who is already rostered fails cleanly", async () => {
    const f = await league("staleclaim");
    const pid = await player("STALE", "Already Owned", "WR");

    await db.actAs(f.managers[0]);
    await db.q("select public.add_free_agent($1, $2)", [f.teamIds[1], pid]);

    await claim(f.leagueId, f.teamIds[2], pid, 50);

    await db.actAs(f.commish);
    await db.q("select public.process_waivers($1)", [f.leagueId]);

    const c = await db.one<{ status: string }>(
      "select status from public.waiver_claims where league_id = $1",
      [f.leagueId],
    );
    assert.equal(c.status, "lost");
  });
});

// ---------------------------------------------------------------------------

describe("draft", () => {
  test("a snake draft reverses the order on even rounds", async () => {
    const f = await league("snake");
    await db.actAs(f.commish);
    await db.q("update public.drafts set rounds = 3 where league_id = $1", [f.leagueId]).catch(() => {});
    const d = await db.one<{ generate_draft: string }>(
      "select public.generate_draft($1) as generate_draft",
      [f.leagueId],
    );
    await db.q("update public.drafts set rounds = 3 where id = $1", [d.generate_draft]);
    await db.q("select public.generate_draft($1, false)", [f.leagueId]);

    const picks = await db.q<{ pick_number: number; round: number; team_id: string }>(
      "select pick_number, round, team_id from public.draft_picks where draft_id = $1 order by pick_number",
      [d.generate_draft],
    );
    assert.equal(picks.length, 12, "3 rounds x 4 teams");

    const r1 = picks.filter((p) => p.round === 1).map((p) => p.team_id);
    const r2 = picks.filter((p) => p.round === 2).map((p) => p.team_id);
    const r3 = picks.filter((p) => p.round === 3).map((p) => p.team_id);

    assert.deepEqual(r2, [...r1].reverse(), "round 2 snakes back");
    assert.deepEqual(r3, r1, "round 3 returns to the original order");
  });

  test("only the team on the clock can pick, and the clock advances", async () => {
    const f = await league("onclock");
    await db.actAs(f.commish);
    const d = await db.one<{ generate_draft: string }>(
      "select public.generate_draft($1) as generate_draft",
      [f.leagueId],
    );
    const draftId = d.generate_draft;
    await db.q("update public.drafts set status = 'live' where id = $1", [draftId]);

    const onClock = await db.one<{ team_id: string }>(
      "select team_id from public.draft_picks where draft_id = $1 and pick_number = 1",
      [draftId],
    );
    const owner = await db.one<{ owner_id: string }>(
      "select owner_id from public.teams where id = $1",
      [onClock.team_id],
    );
    // Must not be the commissioner, who is allowed to pick for anyone.
    const notOnClock = await db.one<{ owner_id: string }>(
      `select owner_id from public.teams
       where league_id = $1 and id <> $2
         and owner_id is not null and owner_id <> $3
       limit 1`,
      [f.leagueId, onClock.team_id, f.commish],
    );

    const pid = await player("DRAFT_QB", "Draft QB", "QB");

    await db.actAs(notOnClock.owner_id);
    await assert.rejects(
      () => db.q("select public.make_draft_pick($1, $2)", [draftId, pid]),
      /not your pick/,
    );

    await db.actAs(owner.owner_id);
    await db.q("select public.make_draft_pick($1, $2)", [draftId, pid]);

    const draft = await db.one<{ current_pick_number: number }>(
      "select current_pick_number from public.drafts where id = $1",
      [draftId],
    );
    assert.equal(draft.current_pick_number, 2);

    const onRoster = await db.q(
      "select 1 from public.roster_players where team_id = $1 and player_id = $2",
      [onClock.team_id, pid],
    );
    assert.equal(onRoster.length, 1, "the pick lands on the roster");
  });

  test("a drafted player cannot be drafted again", async () => {
    const f = await league("dupepick");
    await db.actAs(f.commish);
    const d = await db.one<{ generate_draft: string }>(
      "select public.generate_draft($1) as generate_draft",
      [f.leagueId],
    );
    await db.q("update public.drafts set status = 'live' where id = $1", [d.generate_draft]);

    const pid = await player("DUPE_RB", "Dupe RB", "RB");
    await db.q("select public.make_draft_pick($1, $2)", [d.generate_draft, pid]);
    await assert.rejects(
      () => db.q("select public.make_draft_pick($1, $2)", [d.generate_draft, pid]),
      /already been drafted/,
    );
  });

  test("finishing the last pick completes the draft and starts the season", async () => {
    const f = await league("draftend");
    await db.actAs(f.commish);
    const d = await db.one<{ generate_draft: string }>(
      "select public.generate_draft($1) as generate_draft",
      [f.leagueId],
    );
    const draftId = d.generate_draft;
    await db.q("update public.drafts set rounds = 1 where id = $1", [draftId]);
    await db.q("select public.generate_draft($1, false)", [f.leagueId]);
    await db.q("update public.drafts set status = 'live' where id = $1", [draftId]);

    for (let i = 0; i < 4; i++) {
      const pid = await player(`END_${i}`, `End Player ${i}`, "WR");
      await db.q("select public.make_draft_pick($1, $2)", [draftId, pid]);
    }

    const draft = await db.one<{ status: string }>(
      "select status from public.drafts where id = $1",
      [draftId],
    );
    assert.equal(draft.status, "complete");

    const leagueRow = await db.one<{ status: string }>(
      "select status from public.leagues where id = $1",
      [f.leagueId],
    );
    assert.equal(leagueRow.status, "in_season");
  });
});

// ---------------------------------------------------------------------------

describe("trades", () => {
  test("an executed trade swaps players and moves FAAB", async () => {
    const f = await league("trade");
    const mine = await player("TRADE_MINE", "My Guy", "RB");
    const yours = await player("TRADE_YOURS", "Your Guy", "WR");

    await db.actAs(f.managers[0]);
    await db.q("select public.add_free_agent($1, $2)", [f.teamIds[1], mine]);
    await db.actAs(f.managers[1]);
    await db.q("select public.add_free_agent($1, $2)", [f.teamIds[2], yours]);

    await db.actAs(f.managers[0]);
    const trade = await db.one<{ id: string }>(
      `insert into public.trades
         (league_id, proposing_team_id, receiving_team_id, season, week, status)
       values ($1, $2, $3, $4, 1, 'accepted') returning id`,
      [f.leagueId, f.teamIds[1], f.teamIds[2], SEASON],
    );
    await db.q(
      `insert into public.trade_items (trade_id, from_team_id, player_id) values
         ($1, $2, $3), ($1, $4, $5)`,
      [trade.id, f.teamIds[1], mine, f.teamIds[2], yours],
    );
    await db.q(
      "insert into public.trade_items (trade_id, from_team_id, faab_amount) values ($1, $2, 25)",
      [trade.id, f.teamIds[1]],
    );

    await db.q("select public.execute_trade($1)", [trade.id]);

    const mineNow = await db.one<{ team_id: string }>(
      "select team_id from public.roster_players where league_id = $1 and player_id = $2 and dropped_at is null",
      [f.leagueId, mine],
    );
    assert.equal(mineNow.team_id, f.teamIds[2]);

    const yoursNow = await db.one<{ team_id: string }>(
      "select team_id from public.roster_players where league_id = $1 and player_id = $2 and dropped_at is null",
      [f.leagueId, yours],
    );
    assert.equal(yoursNow.team_id, f.teamIds[1]);

    const sender = await db.one<{ faab_remaining: number }>(
      "select faab_remaining from public.teams where id = $1",
      [f.teamIds[1]],
    );
    const receiver = await db.one<{ faab_remaining: number }>(
      "select faab_remaining from public.teams where id = $1",
      [f.teamIds[2]],
    );
    assert.equal(sender.faab_remaining, 75);
    assert.equal(receiver.faab_remaining, 125);

    const status = await db.one<{ status: string }>(
      "select status from public.trades where id = $1",
      [trade.id],
    );
    assert.equal(status.status, "completed");
  });

  test("a traded player does not go on waivers", async () => {
    const f = await league("tradewaiver");
    const pid = await player("TRADED", "Traded Guy", "TE");

    await db.actAs(f.managers[0]);
    await db.q("select public.add_free_agent($1, $2)", [f.teamIds[1], pid]);

    const trade = await db.one<{ id: string }>(
      `insert into public.trades
         (league_id, proposing_team_id, receiving_team_id, season, week, status)
       values ($1, $2, $3, $4, 1, 'accepted') returning id`,
      [f.leagueId, f.teamIds[1], f.teamIds[2], SEASON],
    );
    await db.q(
      "insert into public.trade_items (trade_id, from_team_id, player_id) values ($1, $2, $3)",
      [trade.id, f.teamIds[1], pid],
    );
    await db.q("select public.execute_trade($1)", [trade.id]);

    const held = await db.one<{ on_waivers: boolean }>(
      "select public.player_on_waivers($1, $2) as on_waivers",
      [f.leagueId, pid],
    );
    assert.equal(held.on_waivers, false);
  });
});
