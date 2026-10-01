/**
 * Lineup locks, enforced by the database (T-039, migration 0042).
 *
 * The whole suite runs with row level security enforced, as the
 * `authenticated` role, because the point is that a manager talking to
 * the database directly -- not just through the my-team server action
 * -- cannot move a player whose game has kicked off.
 *
 * Kickoff times are relative to now(): "an hour ago" and "tomorrow". The
 * lock is worked out from those, never from the stamp the lock-lineups
 * job leaves, except in the tests that are about that job.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, type TestDb } from "./lib/test-db.ts";
import { SEASON, buildLeague, type Fixture } from "./lib/fixtures.ts";
import {
  autoFill,
  earliestGameByTeam,
  planLineupSave,
  type LineupSaveInput,
} from "../src/lib/lineup.ts";
import { expandSlots } from "../src/lib/roster-slots.ts";

let db: TestDb;

before(async () => {
  db = await createTestDb({ enforceRls: true });
});

after(async () => {
  await db.close();
});

// Fixtures -------------------------------------------------------------------

let nextWeek = 0;

/** A fresh week number, so no two tests share a schedule. */
function freshWeek(): number {
  nextWeek += 1;
  return nextWeek;
}

/** An NFL game kicking off `offset` from now, e.g. '-1 hour', '1 day'. */
async function game(week: number, home: string, away: string, offset: string) {
  await db.asSuperuser(() =>
    db.q(
      `insert into public.nfl_games (id, season, week, home_team, away_team, kickoff_at)
       values ($1, $2, $3, $4, $5, now() + $6::interval)`,
      [`LOCK_${SEASON}_${week}_${home}_${away}`, SEASON, week, home, away, offset],
    ),
  );
}

let playerSeq = 0;

async function player(name: string, position: string, team: string): Promise<string> {
  playerSeq += 1;
  const id = `LOCK_P${playerSeq}`;
  await db.asSuperuser(() =>
    db.q(
      `insert into public.nfl_players (id, full_name, position, team_abbr)
       values ($1, $2, $3, $4)`,
      [id, name, position, team],
    ),
  );
  return id;
}

async function roster(f: Fixture, teamId: string, playerId: string) {
  await db.asSuperuser(() =>
    db.q(
      `insert into public.roster_players (league_id, team_id, player_id, acquired_via)
       values ($1, $2, $3, 'draft')`,
      [f.leagueId, teamId, playerId],
    ),
  );
}

/** The current actor, so a helper can step aside and come back. */
async function currentUid(): Promise<string | null> {
  const row = await db.one<{ uid: string }>(
    "select coalesce(current_setting('test.uid', true), '') as uid",
  );
  return row.uid || null;
}

/**
 * A lineup row as it stood before kickoff: written as the system,
 * because once the game has started nobody else could put it there.
 */
async function seat(
  f: Fixture,
  teamId: string,
  week: number,
  playerId: string,
  slot: string,
) {
  const uid = await currentUid();
  await db.actAs(null);
  try {
    await db.asSuperuser(() =>
      db.q(
        `insert into public.lineup_entries
           (league_id, team_id, season, week, player_id, slot_key)
         values ($1, $2, $3, $4, $5, $6)`,
        [f.leagueId, teamId, SEASON, week, playerId, slot],
      ),
    );
  } finally {
    await db.actAs(uid);
  }
}

/**
 * The lock-lineups job, as it runs: the service role, nobody signed in.
 * Leaves whoever was acting signed back in.
 */
async function runLockJob() {
  const uid = await currentUid();
  await db.actAs(null);
  try {
    await db.asSuperuser(() => db.q("select * from public.apply_kickoff_locks()"));
  } finally {
    await db.actAs(uid);
  }
}

async function slotOf(teamId: string, week: number, playerId: string) {
  const rows = await db.asSuperuser(() =>
    db.q<{ slot_key: string }>(
      `select slot_key from public.lineup_entries
       where team_id = $1 and season = $2 and week = $3 and player_id = $4`,
      [teamId, SEASON, week, playerId],
    ),
  );
  return rows[0]?.slot_key ?? null;
}

/** As a manager, straight at the table: what PostgREST would let him do. */
async function move(teamId: string, week: number, playerId: string, slot: string) {
  await db.q(
    `update public.lineup_entries set slot_key = $4
     where team_id = $1 and season = $2 and week = $3 and player_id = $5`,
    [teamId, SEASON, week, slot, playerId],
  );
}

async function insertAs(f: Fixture, teamId: string, week: number, playerId: string, slot: string) {
  await db.q(
    `insert into public.lineup_entries
       (league_id, team_id, season, week, player_id, slot_key)
     values ($1, $2, $3, $4, $5, $6)`,
    [f.leagueId, teamId, SEASON, week, playerId, slot],
  );
}

interface Scene {
  f: Fixture;
  manager: string;
  team: string;
  week: number;
  /** KC, kicked off an hour ago. */
  startedStarter: string;
  startedBench: string;
  /** DAL, kicks off tomorrow. */
  laterStarter: string;
  laterBench: string;
  /** NE, no game this week. */
  byePlayer: string;
}

/**
 * One league, one manager's team, one week: KC-BUF has kicked off,
 * DAL-PHI has not, NE is on a bye.
 */
async function scene(name: string, overrides = ""): Promise<Scene> {
  const f = await buildLeague(db, name, overrides);
  const week = freshWeek();
  await game(week, "KC", "BUF", "-1 hour");
  await game(week, "DAL", "PHI", "1 day");

  const startedStarter = await player(`${name} KC WR`, "WR", "KC");
  const startedBench = await player(`${name} KC RB`, "RB", "KC");
  const laterStarter = await player(`${name} DAL WR`, "WR", "DAL");
  const laterBench = await player(`${name} DAL RB`, "RB", "DAL");
  const byePlayer = await player(`${name} NE WR`, "WR", "NE");

  const team = f.teamIds[1];
  for (const p of [startedStarter, startedBench, laterStarter, laterBench, byePlayer]) {
    await roster(f, team, p);
  }

  await seat(f, team, week, startedStarter, "WR");
  await seat(f, team, week, startedBench, "BN");
  await seat(f, team, week, laterStarter, "WR");
  await seat(f, team, week, laterBench, "BN");
  await seat(f, team, week, byePlayer, "BN");

  const manager = f.managers[0];
  await db.actAs(manager);

  return {
    f, manager, team, week,
    startedStarter, startedBench, laterStarter, laterBench, byePlayer,
  };
}

// per_player -----------------------------------------------------------------

describe("per_player locks", () => {
  test("before kickoff, a player moves freely in and out of the lineup", async () => {
    const s = await scene("pp-before");

    await move(s.team, s.week, s.laterStarter, "BN");
    assert.equal(await slotOf(s.team, s.week, s.laterStarter), "BN");

    await move(s.team, s.week, s.laterBench, "RB");
    assert.equal(await slotOf(s.team, s.week, s.laterBench), "RB");
  });

  test("after kickoff, a starter cannot be benched", async () => {
    const s = await scene("pp-bench");

    await assert.rejects(
      () => move(s.team, s.week, s.startedStarter, "BN"),
      /pp-bench KC WR is locked: his week \d+ game has kicked off\. He has to stay in the WR slot/,
    );
    assert.equal(await slotOf(s.team, s.week, s.startedStarter), "WR");
  });

  test("after kickoff, a benched player cannot be started", async () => {
    const s = await scene("pp-start");

    await assert.rejects(
      () => move(s.team, s.week, s.startedBench, "RB"),
      /cannot move into the starting lineup/,
    );
    assert.equal(await slotOf(s.team, s.week, s.startedBench), "BN");
  });

  test("after kickoff, moving along the bench is still allowed", async () => {
    const s = await scene("pp-bench-bench");

    await move(s.team, s.week, s.startedBench, "IR");
    assert.equal(await slotOf(s.team, s.week, s.startedBench), "IR");

    // Off the board altogether is the bench too: it scores nothing.
    await db.q(
      `delete from public.lineup_entries
       where team_id = $1 and week = $2 and player_id = $3`,
      [s.team, s.week, s.startedBench],
    );
    assert.equal(await slotOf(s.team, s.week, s.startedBench), null);
  });

  test("a locked starter cannot be swapped for an unlocked bench player", async () => {
    const s = await scene("pp-swap");

    // The swap as one statement, the way an upsert would send it.
    await assert.rejects(
      () =>
        db.q(
          `update public.lineup_entries
             set slot_key = case when player_id = $3 then 'BN' else 'WR' end
           where team_id = $1 and week = $2 and player_id in ($3, $4)`,
          [s.team, s.week, s.startedStarter, s.laterStarter],
        ),
      /is locked/,
    );
    assert.equal(await slotOf(s.team, s.week, s.startedStarter), "WR");
    assert.equal(await slotOf(s.team, s.week, s.laterStarter), "WR");
  });

  test("players whose games have not started still move around a locked one", async () => {
    const s = await scene("pp-around");

    await move(s.team, s.week, s.laterStarter, "BN");
    await move(s.team, s.week, s.laterBench, "FLEX");
    assert.equal(await slotOf(s.team, s.week, s.laterBench), "FLEX");
    assert.equal(await slotOf(s.team, s.week, s.startedStarter), "WR");
  });

  test("a finished week is locked too", async () => {
    const s = await scene("pp-finished");
    const past = freshWeek();
    await game(past, "DAL", "PHI", "-8 days");
    await seat(s.f, s.team, past, s.laterStarter, "WR");

    await assert.rejects(() => move(s.team, past, s.laterStarter, "BN"), /is locked/);
  });

  test("a bye-week player never locks in per_player mode", async () => {
    const s = await scene("pp-bye");

    await move(s.team, s.week, s.byePlayer, "FLEX");
    assert.equal(await slotOf(s.team, s.week, s.byePlayer), "FLEX");
    await move(s.team, s.week, s.byePlayer, "BN");
    assert.equal(await slotOf(s.team, s.week, s.byePlayer), "BN");
  });
});

// weekly_kickoff -------------------------------------------------------------

describe("weekly_kickoff locks", () => {
  test("the first kickoff of the week locks every starting slot", async () => {
    const s = await scene("wk-lock", "lineup_lock_mode = 'weekly_kickoff'");

    // DAL has not played yet, but the week has started.
    await assert.rejects(
      () => move(s.team, s.week, s.laterStarter, "BN"),
      /the first game of week \d+ has kicked off, so the lineup is locked/,
    );
    await assert.rejects(() => move(s.team, s.week, s.laterBench, "RB"), /is locked/);
  });

  test("a bye-week player locks with everybody else", async () => {
    const s = await scene("wk-bye", "lineup_lock_mode = 'weekly_kickoff'");
    await assert.rejects(() => move(s.team, s.week, s.byePlayer, "FLEX"), /is locked/);
  });

  test("the bench is still the bench", async () => {
    const s = await scene("wk-bench", "lineup_lock_mode = 'weekly_kickoff'");
    await move(s.team, s.week, s.laterBench, "IR");
    assert.equal(await slotOf(s.team, s.week, s.laterBench), "IR");
  });

  test("before the first kickoff, nothing is locked", async () => {
    const f = await buildLeague(db, "wk-early", "lineup_lock_mode = 'weekly_kickoff'");
    const week = freshWeek();
    await game(week, "KC", "BUF", "1 day");
    const p = await player("wk-early KC WR", "WR", "KC");
    await roster(f, f.teamIds[1], p);
    await seat(f, f.teamIds[1], week, p, "BN");

    await db.actAs(f.managers[0]);
    await move(f.teamIds[1], week, p, "WR");
    assert.equal(await slotOf(f.teamIds[1], week, p), "WR");
  });
});

// Direct writes ---------------------------------------------------------------

describe("nobody gets round it by writing the table", () => {
  test("a manager cannot delete a locked starter or insert a started player", async () => {
    const s = await scene("rls-direct");

    await assert.rejects(
      () =>
        db.q(
          `delete from public.lineup_entries
           where team_id = $1 and week = $2 and player_id = $3`,
          [s.team, s.week, s.startedStarter],
        ),
      /is locked/,
    );

    await db.q(
      `delete from public.lineup_entries
       where team_id = $1 and week = $2 and player_id = $3`,
      [s.team, s.week, s.startedBench],
    );
    await assert.rejects(
      () => insertAs(s.f, s.team, s.week, s.startedBench, "RB"),
      /cannot move into the starting lineup/,
    );
  });

  test("a stamped lock cannot be cleared", async () => {
    const s = await scene("rls-unstamp");
    await runLockJob();

    await assert.rejects(
      () =>
        db.q(
          `update public.lineup_entries set locked_at = null
           where team_id = $1 and week = $2 and player_id = $3`,
          [s.team, s.week, s.startedStarter],
        ),
      /cannot be unlocked/,
    );
  });

  test("setting the override flag yourself does not help a manager", async () => {
    const s = await scene("rls-flag");
    await db.q("select set_config('app.lineup_override', 'on', false)");
    try {
      await assert.rejects(() => move(s.team, s.week, s.startedStarter, "BN"), /is locked/);
    } finally {
      await db.q("select set_config('app.lineup_override', '', false)");
    }
  });

  test("the commissioner cannot write a locked lineup directly either", async () => {
    const s = await scene("rls-commish");
    await db.actAs(s.f.commish);
    await assert.rejects(() => move(s.team, s.week, s.startedStarter, "BN"), /is locked/);
  });
});

// Drops ------------------------------------------------------------------------

describe("dropping a player", () => {
  test("a locked starter's row stays; a started bench player's row goes", async () => {
    const s = await scene("drop-locked");
    await db.asSuperuser(() =>
      db.q("update public.leagues set current_week = $2 where id = $1", [
        s.f.leagueId,
        s.week,
      ]),
    );

    await db.q("select public.drop_player($1, $2)", [s.team, s.startedStarter]);
    await db.q("select public.drop_player($1, $2)", [s.team, s.startedBench]);

    assert.equal(
      await slotOf(s.team, s.week, s.startedStarter),
      "WR",
      "his points still count for the week he was locked in",
    );
    assert.equal(await slotOf(s.team, s.week, s.startedBench), null);
  });
});

// Trades -----------------------------------------------------------------------

describe("trading a player", () => {
  test("a locked starter's week stays with the team that started him", async () => {
    const s = await scene("trade-locked");
    const later = freshWeek();
    await game(later, "KC", "BUF", "7 days");
    await seat(s.f, s.team, later, s.startedStarter, "WR");

    const other = s.f.teamIds[2];
    const trade = await db.asSuperuser(async () => {
      await db.q("update public.leagues set current_week = $2 where id = $1", [
        s.f.leagueId,
        s.week,
      ]);
      await db.q(
        `insert into public.player_week_scores (league_id, player_id, season, week, points)
         values ($1, $2, $3, $4, 17)`,
        [s.f.leagueId, s.startedStarter, SEASON, s.week],
      );
      const row = await db.one<{ id: string }>(
        `insert into public.trades
           (league_id, proposing_team_id, receiving_team_id, status, season, week)
         values ($1, $2, $3, 'accepted', $4, $5) returning id`,
        [s.f.leagueId, s.team, other, SEASON, s.week],
      );
      await db.q(
        `insert into public.trade_items (trade_id, from_team_id, player_id)
         values ($1, $2, $3)`,
        [row.id, s.team, s.startedStarter],
      );
      return row;
    });

    await db.q("select public.execute_trade($1)", [trade.id]);

    assert.equal(
      await slotOf(s.team, s.week, s.startedStarter),
      "WR",
      "locked into the sending team's lineup this week",
    );
    assert.equal(
      await slotOf(s.team, later, s.startedStarter),
      null,
      "gone from the sending team's later, unlocked week",
    );

    const points = await db.q<{ team_id: string; points: string }>(
      "select team_id, points from public.team_week_points($1, $2, $3)",
      [s.f.leagueId, SEASON, s.week],
    );
    assert.equal(
      Number(points.find((p) => p.team_id === s.team)?.points),
      17,
      "and his points count for the team that started him",
    );

    // His new team can put him on the bench, not in the lineup.
    await db.actAs(s.f.managers[1]);
    await insertAs(s.f, other, s.week, s.startedStarter, "BN");
    assert.equal(await slotOf(other, s.week, s.startedStarter), "BN");
    await assert.rejects(() => move(other, s.week, s.startedStarter, "WR"), /is locked/);
  });
});

// Grants -----------------------------------------------------------------------

describe("who can call what", () => {
  test("nobody signed in can call internal_drop, member or not", async () => {
    const s = await scene("grant-drop");
    const outsider = await db.createUser("drop-outsider@example.com");

    for (const who of [outsider, s.manager, s.f.commish]) {
      await db.actAs(who);
      await assert.rejects(
        () => db.q("select public.internal_drop($1, $2, true)", [s.team, s.laterBench]),
        /permission denied for function internal_drop/,
      );
    }

    const owned = await db.asSuperuser(() =>
      db.q(
        `select 1 from public.roster_players
         where team_id = $1 and player_id = $2 and dropped_at is null`,
        [s.team, s.laterBench],
      ),
    );
    assert.equal(owned.length, 1, "still on the roster");
  });

  test("a signed-out visitor cannot call execute_trade or process_waivers", async () => {
    const f = await buildLeague(db, "grant-anon");
    await db.actAs(null);
    await db.asSuperuser(async () => {
      // Supabase gives anon the schema; without it the call would fail
      // for the wrong reason.
      await db.exec("grant usage on schema public to anon; set role anon;");
      try {
        await assert.rejects(
          () =>
            db.q("select public.execute_trade($1)", [
              "00000000-0000-0000-0000-000000000000",
            ]),
          /permission denied for function execute_trade/,
        );
        await assert.rejects(
          () => db.q("select public.process_waivers($1)", [f.leagueId]),
          /permission denied for function process_waivers/,
        );
      } finally {
        await db.exec("reset role;");
      }
    });
  });
});

// Free agents ------------------------------------------------------------------

/**
 * Waivers run tomorrow, in the league's timezone, so the last scheduled
 * run was six days ago whatever day the suite runs on.
 */
const WAIVERS_TOMORROW = `waiver_process_dow =
  ((extract(dow from now() at time zone 'America/New_York')::int + 1) % 7)`;

describe("free agents whose game has started", () => {
  test("with locked_players_to_waivers on, he can only be claimed", async () => {
    const f = await buildLeague(db, "fa-waivers", WAIVERS_TOMORROW);
    const week = freshWeek();
    await game(week, "MIA", "NE", "-1 hour");
    const fa = await player("fa-waivers MIA WR", "WR", "MIA");
    const team = f.teamIds[1];

    await db.actAs(f.managers[0]);
    await assert.rejects(
      () => db.q("select public.add_free_agent($1, $2)", [team, fa]),
      /His game has kicked off, so he is on waivers until waivers next run/,
    );

    await db.q(
      `insert into public.waiver_claims
         (league_id, team_id, add_player_id, bid_amount, season, week)
       values ($1, $2, $3, 0, $4, $5)`,
      [f.leagueId, team, fa, SEASON, week],
    );
    await db.actAs(f.commish);
    await db.q("select public.process_waivers($1)", [f.leagueId]);

    const owned = await db.q(
      `select 1 from public.roster_players
       where team_id = $1 and player_id = $2 and dropped_at is null`,
      [team, fa],
    );
    assert.equal(owned.length, 1, "the claim is awarded");

    // Claimed, and still not startable this week.
    await db.actAs(f.managers[0]);
    await assert.rejects(
      () => insertAs(f, team, week, fa, "WR"),
      /cannot move into the starting lineup/,
    );
  });

  test("with it off, he can be added to the bench but not started", async () => {
    const f = await buildLeague(
      db,
      "fa-bench",
      `${WAIVERS_TOMORROW}, locked_players_to_waivers = false`,
    );
    const week = freshWeek();
    await game(week, "NYJ", "LV", "-1 hour");
    const fa = await player("fa-bench NYJ WR", "WR", "NYJ");
    const team = f.teamIds[1];

    await db.actAs(f.managers[0]);
    await db.q("select public.add_free_agent($1, $2)", [team, fa]);

    await assert.rejects(
      () => insertAs(f, team, week, fa, "WR"),
      /cannot move into the starting lineup/,
    );
    await insertAs(f, team, week, fa, "BN");
    assert.equal(await slotOf(team, week, fa), "BN");
  });

  test("a game from before the last waiver run does not send him to waivers", async () => {
    const f = await buildLeague(db, "fa-old", WAIVERS_TOMORROW);
    const week = freshWeek();
    await game(week, "TEN", "JAX", "-8 days");
    const fa = await player("fa-old TEN WR", "WR", "TEN");

    await db.actAs(f.managers[0]);
    await db.q("select public.add_free_agent($1, $2)", [f.teamIds[1], fa]);
  });

  test("the job puts him on waivers in the pool until the next run", async () => {
    const f = await buildLeague(db, "fa-hold", WAIVERS_TOMORROW);
    const week = freshWeek();
    await game(week, "CAR", "ATL", "-1 hour");
    const fa = await player("fa-hold CAR WR", "WR", "CAR");

    await runLockJob();

    const holdOf = () =>
      db.asSuperuser(() =>
        db.q<{ until_waivers_run: boolean; backstop: boolean }>(
          `select until_waivers_run,
                  clears_at > public.next_waiver_run(league_id) as backstop
           from public.waiver_holds where league_id = $1 and player_id = $2`,
          [f.leagueId, fa],
        ),
      );

    const [hold] = await holdOf();
    assert.equal(hold.until_waivers_run, true, "held until the next run");
    assert.equal(hold.backstop, true, "the date is only a backstop, after the run");

    // The run clears it; nobody claimed him, so he is a free agent.
    await db.actAs(f.commish);
    await db.q("select public.process_waivers($1)", [f.leagueId]);
    assert.equal((await holdOf()).length, 0);

    await db.actAs(f.managers[0]);
    await db.q("select public.add_free_agent($1, $2)", [f.teamIds[1], fa]);
  });

  test("a late waiver run: past the scheduled time but not yet run, he is still on waivers", async () => {
    // Waivers were scheduled for midnight yesterday; the last run that
    // actually happened was five days ago. His game kicked off three
    // days ago, between the two.
    const f = await buildLeague(
      db,
      "fa-late-run",
      `waiver_process_dow =
         (extract(dow from (now() - interval '1 day') at time zone 'America/New_York')::int),
       waiver_process_time = '00:00'`,
    );
    // Only a waiver run may write this, so it is set as the system.
    await db.actAs(null);
    await db.asSuperuser(() =>
      db.q(
        `update public.leagues set waivers_processed_at = now() - interval '5 days'
         where id = $1`,
        [f.leagueId],
      ),
    );
    const week = freshWeek();
    await game(week, "SEA", "SF", "-3 days");
    const fa = await player("fa-late SEA WR", "WR", "SEA");
    const team = f.teamIds[1];

    const scheduledAfterKickoff = await db.asSuperuser(() =>
      db.one<{ ok: boolean }>(
        `select public.last_waiver_run($1) > now() - interval '3 days' as ok`,
        [f.leagueId],
      ),
    );
    assert.equal(scheduledAfterKickoff.ok, true, "the scheduled time has passed");

    await db.actAs(f.managers[0]);
    await assert.rejects(
      () => db.q("select public.add_free_agent($1, $2)", [team, fa]),
      /on waivers until waivers next run/,
    );

    // The job, running in the gap, holds him rather than letting go.
    await runLockJob();
    const held = await db.asSuperuser(() =>
      db.q(
        `select 1 from public.waiver_holds
         where league_id = $1 and player_id = $2 and clears_at > now()`,
        [f.leagueId, fa],
      ),
    );
    assert.equal(held.length, 1);

    // Then waivers actually run, and he is free.
    await db.actAs(f.commish);
    await db.q("select public.process_waivers($1)", [f.leagueId]);
    const stamped = await db.one<{ recent: boolean }>(
      `select waivers_processed_at > now() - interval '1 minute' as recent
       from public.leagues where id = $1`,
      [f.leagueId],
    );
    assert.equal(stamped.recent, true, "process_waivers records the run");

    await db.actAs(f.managers[0]);
    await db.q("select public.add_free_agent($1, $2)", [team, fa]);
  });

  test("the commissioner cannot say waivers have run", async () => {
    const f = await buildLeague(db, "fa-fake-run", WAIVERS_TOMORROW);
    const week = freshWeek();
    await game(week, "DEN", "LAC", "-1 hour");
    const fa = await player("fa-fake DEN WR", "WR", "DEN");
    await runLockJob();

    await db.actAs(f.commish);
    for (const when of ["now()", "now() + interval '1 year'"]) {
      await assert.rejects(
        () =>
          db.q(
            `update public.leagues set waivers_processed_at = ${when} where id = $1`,
            [f.leagueId],
          ),
        /Only a waiver run can set waivers_processed_at/,
        when,
      );
    }

    // Nor can a league be created with it set.
    await assert.rejects(
      () =>
        db.q(
          `insert into public.leagues
             (name, season, commissioner_id, team_count, waivers_processed_at)
           values ('fa-fake-run 2', $1, $2, 4, now() + interval '1 year')`,
          [SEASON, f.commish],
        ),
      /Only a waiver run can set waivers_processed_at/,
    );

    const holds = await db.asSuperuser(() =>
      db.q(
        `select 1 from public.waiver_holds
         where league_id = $1 and player_id = $2 and until_waivers_run`,
        [f.leagueId, fa],
      ),
    );
    assert.equal(holds.length, 1, "the kickoff hold is still there");

    await assert.rejects(
      () => db.q("select public.add_free_agent($1, $2)", [f.teamIds[0], fa]),
      /on waivers/,
    );
  });

  test("a drop over a leftover kickoff hold starts its own clock", async () => {
    const f = await buildLeague(db, "fa-drop-over", WAIVERS_TOMORROW);
    const week = freshWeek();
    await game(week, "DET", "GB", "-1 hour");
    const p = await player("fa-drop DET WR", "WR", "DET");
    await runLockJob();

    // Claimed while held, then dropped again.
    const team = f.teamIds[1];
    await roster(f, team, p);
    await db.actAs(f.managers[0]);
    await db.q("select public.drop_player($1, $2)", [team, p]);

    const holdOf = () =>
      db.asSuperuser(() =>
        db.q<{ until_waivers_run: boolean; period: boolean }>(
          `select until_waivers_run,
                  clears_at > now() + interval '47 hours' as period
           from public.waiver_holds where league_id = $1 and player_id = $2`,
          [f.leagueId, p],
        ),
      );

    assert.deepEqual(await holdOf(), [{ until_waivers_run: false, period: true }]);

    // The next run does not cut the drop's waiver period short.
    await db.actAs(f.commish);
    await db.q("select public.process_waivers($1)", [f.leagueId]);
    assert.deepEqual(await holdOf(), [{ until_waivers_run: false, period: true }]);
  });
});

// Commissioner override --------------------------------------------------------

describe("the commissioner's override", () => {
  test("moves a locked starter and logs it", async () => {
    const s = await scene("override");
    await db.actAs(s.f.commish);

    await db.q("select public.commissioner_set_lineup_slot($1, $2, $3, $4, $5)", [
      s.team, s.week, s.startedStarter, "BN", "site was down before kickoff",
    ]);
    await db.q("select public.commissioner_set_lineup_slot($1, $2, $3, $4, $5)", [
      s.team, s.week, s.startedBench, "RB", "moved up in his place",
    ]);

    assert.equal(await slotOf(s.team, s.week, s.startedStarter), "BN");
    assert.equal(await slotOf(s.team, s.week, s.startedBench), "RB");

    const log = await db.q<{ note: string; created_by: string }>(
      `select note, created_by from public.transactions
       where team_id = $1 and type = 'commissioner' order by created_at, note`,
      [s.team],
    );
    assert.equal(log.length, 2);
    assert.ok(
      log.some((l) =>
        l.note.includes("from WR to BN") &&
        l.note.includes("Reason: site was down before kickoff"),
      ),
      JSON.stringify(log),
    );
    assert.ok(log.every((l) => l.created_by === s.f.commish));
    assert.ok(log.every((l) => l.note.includes(". Reason: ")), "every line says why");

    // The flag does not outlive the call.
    await assert.rejects(() => move(s.team, s.week, s.startedBench, "BN"), /is locked/);
  });

  test("still checks the slot", async () => {
    const s = await scene("override-checks");
    await db.actAs(s.f.commish);
    await assert.rejects(
      () =>
        db.q("select public.commissioner_set_lineup_slot($1, $2, $3, $4, $5)", [
          s.team, s.week, s.startedBench, "QB", "testing",
        ]),
      /A RB cannot play at QB/,
    );
  });

  test("needs a reason, and not an essay", async () => {
    const s = await scene("override-reason");
    await db.actAs(s.f.commish);

    const call = (note: string | null) =>
      db.q("select public.commissioner_set_lineup_slot($1, $2, $3, $4, $5)", [
        s.team, s.week, s.startedStarter, "BN", note,
      ]);

    await assert.rejects(() => call(""), /Give a reason for the override/);
    await assert.rejects(() => call("   "), /Give a reason for the override/);
    await assert.rejects(() => call(null), /Give a reason for the override/);
    await assert.rejects(() => call("x".repeat(201)), /Keep the reason to 200 characters/);
    await assert.rejects(
      () =>
        db.q("select public.commissioner_set_lineup_slot($1, $2, $3, $4)", [
          s.team, s.week, s.startedStarter, "BN",
        ]),
      /does not exist/,
      "there is no reasonless form of the call",
    );

    assert.equal(await slotOf(s.team, s.week, s.startedStarter), "WR", "nothing moved");
    const log = await db.q(
      "select 1 from public.transactions where team_id = $1 and type = 'commissioner'",
      [s.team],
    );
    assert.equal(log.length, 0, "and nothing was logged");
  });

  test("is the commissioner's alone", async () => {
    const s = await scene("override-manager");
    await assert.rejects(
      () =>
        db.q("select public.commissioner_set_lineup_slot($1, $2, $3, $4, $5)", [
          s.team, s.week, s.startedStarter, "BN", "because I said so",
        ]),
      /Only the commissioner can override a lineup/,
    );
  });
});

// The job and the rule -------------------------------------------------------

describe("the lock-lineups job agrees with the trigger", () => {
  test("it stamps exactly the rows the rule says are locked", async () => {
    const pp = await scene("job-pp");
    const wk = await scene("job-wk", "lineup_lock_mode = 'weekly_kickoff'");

    await runLockJob();

    const rows = await db.asSuperuser(() =>
      db.q<{ player_id: string; league_id: string; stamped: boolean; rule: boolean }>(
        `select player_id, league_id,
                locked_at is not null as stamped,
                public.lineup_player_locked(league_id, season, week, player_id) as rule
         from public.lineup_entries
         where league_id in ($1, $2)`,
        [pp.f.leagueId, wk.f.leagueId],
      ),
    );
    assert.equal(rows.length, 10);
    for (const r of rows) {
      assert.equal(r.stamped, r.rule, `${r.player_id} in ${r.league_id}`);
    }

    const stamped = (s: Scene) =>
      rows
        .filter((r) => r.league_id === s.f.leagueId && r.stamped)
        .map((r) => r.player_id)
        .sort();
    assert.deepEqual(stamped(pp), [pp.startedStarter, pp.startedBench].sort());
    assert.equal(stamped(wk).length, 5, "weekly: the whole lineup");

    // Stamped or not, the trigger gives the same answers.
    await db.actAs(pp.manager);
    await assert.rejects(() => move(pp.team, pp.week, pp.startedStarter, "BN"), /is locked/);
    await move(pp.team, pp.week, pp.startedBench, "IR");
    await move(pp.team, pp.week, pp.laterBench, "RB");
  });

  test("the lock state the editor reads matches too", async () => {
    const s = await scene("job-editor");
    const locks = await db.q<{ player_id: string; locked: boolean }>(
      "select player_id, locked from public.lineup_locks($1, $2, $3)",
      [s.team, SEASON, s.week],
    );
    const locked = locks.filter((l) => l.locked).map((l) => l.player_id).sort();
    assert.deepEqual(locked, [s.startedStarter, s.startedBench].sort());
  });

  test("nobody signed in can run the job, and outsiders see no lock state", async () => {
    const s = await scene("job-grants");
    await assert.rejects(() => db.q("select * from public.apply_kickoff_locks()"));

    const outsider = await db.createUser("lock-outsider@example.com");
    await db.actAs(outsider);
    const locks = await db.q("select * from public.lineup_locks($1, $2, $3)", [
      s.team, SEASON, s.week,
    ]);
    assert.equal(locks.length, 0);
  });
});

// The editor's side -----------------------------------------------------------

describe("planning a save", () => {
  const slots = [
    { slot_key: "WR", count: 2, is_starter: true, eligible_positions: ["WR"] },
    { slot_key: "RB", count: 1, is_starter: true, eligible_positions: ["RB"] },
    { slot_key: "BN", count: 3, is_starter: false, eligible_positions: [] },
    { slot_key: "IR", count: 1, is_starter: false, eligible_positions: [] },
  ];

  function input(over: Partial<LineupSaveInput>): LineupSaveInput {
    return {
      week: 3,
      lockMode: "per_player",
      slots,
      current: new Map([["wr1", "WR"], ["rb1", "BN"], ["wr2", "BN"]]),
      locked: new Set(["wr1"]),
      roster: new Map([["wr1", "WR"], ["rb1", "RB"], ["wr2", "WR"]]),
      names: new Map([["wr1", "Locked Receiver"]]),
      submitted: new Map(),
      ...over,
    };
  }

  test("benching a locked starter is refused, by name", () => {
    const plan = planLineupSave(
      input({ submitted: new Map([["wr1", "BN"], ["rb1", "BN"], ["wr2", "WR"]]) }),
    );
    assert.deepEqual(plan, {
      error: "Locked Receiver is locked: his week 3 game has kicked off. He has to stay at WR.",
    });
  });

  test("weekly mode says why in its own words", () => {
    const plan = planLineupSave(
      input({
        lockMode: "weekly_kickoff",
        submitted: new Map([["wr1", "BN"]]),
      }),
    );
    assert.ok("error" in plan && plan.error.includes("the first game of week 3"));
  });

  test("a locked player the form left out stays put, and is not rewritten", () => {
    const plan = planLineupSave(
      input({ submitted: new Map([["rb1", "RB"], ["wr2", "WR"]]) }),
    );
    assert.deepEqual(plan, {
      upserts: [
        { playerId: "rb1", slotKey: "RB" },
        { playerId: "wr2", slotKey: "WR" },
      ],
      deletes: [],
    });
  });

  test("a locked bench player may move along the bench", () => {
    const plan = planLineupSave(
      input({
        current: new Map([["wr1", "WR"], ["rb1", "BN"]]),
        locked: new Set(["wr1", "rb1"]),
        submitted: new Map([["rb1", "IR"]]),
      }),
    );
    assert.deepEqual(plan, { upserts: [{ playerId: "rb1", slotKey: "IR" }], deletes: [] });
  });

  test("a locked starter who has been dropped keeps his slot and counts toward it", () => {
    const plan = planLineupSave(
      input({
        roster: new Map([["rb1", "RB"], ["wr2", "WR"]]),
        submitted: new Map([["rb1", "RB"], ["wr2", "WR"]]),
      }),
    );
    assert.deepEqual(plan, {
      upserts: [
        { playerId: "rb1", slotKey: "RB" },
        { playerId: "wr2", slotKey: "WR" },
      ],
      deletes: [],
    });
  });

  test("taking an unlocked player out of the lineup deletes his row", () => {
    const plan = planLineupSave(input({ submitted: new Map([["wr2", ""]]) }));
    assert.deepEqual(plan, { upserts: [], deletes: ["rb1", "wr2"] });
  });
});

describe("the game a roster row reads off", () => {
  /*
   * The row shows a kickoff next to the padlock, and the padlock comes
   * from the earliest kickoff of the team's week (player_week_kickoff).
   * A team with two games in one week must not show the later one.
   */
  const early = { home_team: "KC", away_team: "BUF", kickoff_at: "2026-09-17T00:15:00Z" };
  const late = { home_team: "LA", away_team: "KC", kickoff_at: "2026-09-20T17:00:00Z" };

  test("a team playing twice reads off the earlier game, whatever order they arrive in", () => {
    for (const games of [[early, late], [late, early]]) {
      const byTeam = earliestGameByTeam(games);
      assert.equal(byTeam.get("KC"), early, "KC locks at the Thursday game");
      assert.equal(byTeam.get("BUF"), early);
      assert.equal(byTeam.get("LA"), late);
    }
  });

  test("a game with no kickoff time yet only stands in for nothing", () => {
    const undated = { home_team: "KC", away_team: "NE", kickoff_at: null };

    assert.equal(earliestGameByTeam([undated, late]).get("KC"), late);
    assert.equal(earliestGameByTeam([late, undated]).get("KC"), late);
    assert.equal(earliestGameByTeam([undated]).get("KC"), undated);
  });
});

describe("dealing the board", () => {
  test("a locked player is never dealt into a starting spot", () => {
    const spots = expandSlots([
      { id: "1", league_id: "l", slot_key: "WR", label: "WR", eligible_positions: ["WR"], count: 1, is_starter: true, order_index: 1 },
      { id: "2", league_id: "l", slot_key: "BN", label: "Bench", eligible_positions: [], count: 2, is_starter: false, order_index: 2 },
    ]);
    const empty = Object.fromEntries(spots.map((s) => [s.key, null]));
    const placed = autoFill(empty, spots, [
      { playerId: "star", points: 30, player: { position: "WR" }, locked: true },
      { playerId: "scrub", points: 2, player: { position: "WR" } },
    ]);

    assert.equal(placed["WR-0"], "scrub");
    assert.equal(placed["BN-0"], "star");
  });
});
