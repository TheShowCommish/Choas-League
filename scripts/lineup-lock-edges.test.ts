/**
 * Lineup locks: the corners (T-039, migration 0042).
 *
 * The author's scripts/lineup-lock.test.ts covers the rule. This file is
 * the testing pass over the edges a fantasy manager actually finds on a
 * Sunday: a Thursday-night starter next to Sunday ones, a flex, a player
 * who changes hands mid-week, a team playing twice, a schedule
 * correction, the waiver clock across a DST change, a double-submitted
 * save, a save that races the lock job, and a commissioner reaching into
 * somebody else's league.
 *
 * Like the author's suite it runs with RLS enforced as `authenticated`,
 * because the point of 0042 is that the rule holds even when the write
 * goes straight at the table.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, type TestDb } from "./lib/test-db.ts";
import { SEASON, buildLeague, type Fixture } from "./lib/fixtures.ts";
import { planLineupSave, autoFill, type LineupSpot } from "../src/lib/lineup.ts";
import { expandSlots } from "../src/lib/roster-slots.ts";
import type { RosterSlot } from "../src/lib/types.ts";

let db: TestDb;

before(async () => {
  db = await createTestDb({ enforceRls: true });
});

after(async () => {
  await db.close();
});

// Fixtures -------------------------------------------------------------------

let nextWeek = 0;
function freshWeek(): number {
  nextWeek += 1;
  return nextWeek;
}

let gameSeq = 0;

/** An NFL game kicking off `offset` from now, e.g. '-1 hour', '1 day'. */
async function game(
  week: number,
  home: string,
  away: string,
  offset: string,
  seasonType = "REG",
): Promise<string> {
  gameSeq += 1;
  const id = `EDGE_G${gameSeq}`;
  await db.asSuperuser(() =>
    db.q(
      `insert into public.nfl_games
         (id, season, week, home_team, away_team, kickoff_at, season_type)
       values ($1, $2, $3, $4, $5, now() + $6::interval, $7)`,
      [id, SEASON, week, home, away, offset, seasonType],
    ),
  );
  return id;
}

let playerSeq = 0;

async function player(name: string, position: string, team: string): Promise<string> {
  playerSeq += 1;
  const id = `EDGE_P${playerSeq}`;
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

async function currentUid(): Promise<string | null> {
  const row = await db.one<{ uid: string }>(
    "select coalesce(current_setting('test.uid', true), '') as uid",
  );
  return row.uid || null;
}

/** A lineup row as it stood before kickoff, written as the system. */
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

/** The lock-lineups job, as it runs: service role, nobody signed in. */
async function runLockJob(): Promise<{ locked: number; held: number }> {
  const uid = await currentUid();
  await db.actAs(null);
  try {
    return await db.asSuperuser(async () => {
      const rows = await db.q<{ locked: number; held: number }>(
        "select * from public.apply_kickoff_locks()",
      );
      return rows[0];
    });
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

async function isLocked(teamId: string, week: number, playerId: string) {
  const rows = await db.q<{ locked: boolean }>(
    `select locked from public.lineup_locks($1, $2, $3) where player_id = $4`,
    [teamId, SEASON, week, playerId],
  );
  return rows[0]?.locked ?? null;
}

async function refuses(fn: () => Promise<unknown>, needle: string, what: string) {
  await assert.rejects(fn, (err: Error) => {
    assert.match(err.message, new RegExp(needle, "i"), `${what}: ${err.message}`);
    return true;
  }, what);
}

// A Thursday starter beside Sunday ones ---------------------------------------

describe("a Thursday-night starter, and the rest of the week", () => {
  test("the TNF player is locked while Sunday players still move", async () => {
    const f = await buildLeague(db, "edge-tnf");
    const week = freshWeek();
    await game(week, "KC", "BUF", "-3 days"); // Thursday night, done
    await game(week, "DAL", "PHI", "2 days"); // Sunday, not yet
    await game(week, "SF", "SEA", "3 days"); // Monday night

    const tnf = await player("TNF WR", "WR", "KC");
    const sun = await player("Sunday WR", "WR", "DAL");
    const mnf = await player("Monday WR", "WR", "SF");
    const spare = await player("Bench WR", "WR", "DAL");

    const team = f.teamIds[1];
    for (const p of [tnf, sun, mnf, spare]) await roster(f, team, p);
    await seat(f, team, week, tnf, "WR");
    await seat(f, team, week, sun, "WR");
    await seat(f, team, week, mnf, "BN");
    await seat(f, team, week, spare, "BN");

    await db.actAs(f.managers[0]);

    assert.equal(await isLocked(team, week, tnf), true, "TNF player locked");
    assert.equal(await isLocked(team, week, sun), false, "Sunday player free");
    assert.equal(await isLocked(team, week, mnf), false, "Monday player free");

    await refuses(
      () => move(team, week, tnf, "BN"),
      "locked",
      "the Thursday starter cannot be benched",
    );

    // Sunday and Monday players still swap freely around him.
    await move(team, week, sun, "BN");
    await move(team, week, mnf, "WR");
    assert.equal(await slotOf(team, week, sun), "BN");
    assert.equal(await slotOf(team, week, mnf), "WR");
    assert.equal(await slotOf(team, week, tnf), "WR", "TNF player untouched");
  });
});

// A flex ----------------------------------------------------------------------

describe("the flex slot", () => {
  test("a locked Sunday starter will not come out; an unlocked flex will", async () => {
    const f = await buildLeague(db, "edge-flex");
    const week = freshWeek();
    await game(week, "KC", "BUF", "-20 minutes"); // early Sunday, under way
    await game(week, "DAL", "PHI", "4 hours"); // late Sunday

    const lockedWr = await player("Locked WR", "WR", "KC");
    const flexTe = await player("Flex TE", "TE", "DAL");
    const benchRb = await player("Bench RB", "RB", "DAL");
    const benchWr = await player("Bench WR", "WR", "DAL");

    const team = f.teamIds[1];
    for (const p of [lockedWr, flexTe, benchRb, benchWr]) await roster(f, team, p);
    await seat(f, team, week, lockedWr, "WR");
    await seat(f, team, week, flexTe, "FLEX");
    await seat(f, team, week, benchRb, "BN");
    await seat(f, team, week, benchWr, "BN");

    await db.actAs(f.managers[0]);

    // Swapping the locked WR out for a bench WR: his leg is refused, so
    // the swap the editor would send cannot complete.
    await refuses(
      () => move(team, week, lockedWr, "BN"),
      "locked",
      "the started WR cannot leave WR",
    );
    assert.equal(await slotOf(team, week, lockedWr), "WR");
    assert.equal(await slotOf(team, week, benchWr), "BN");

    // The flex is a different story: nobody in it has kicked off.
    await move(team, week, flexTe, "BN");
    await move(team, week, benchRb, "FLEX");
    assert.equal(await slotOf(team, week, flexTe), "BN");
    assert.equal(await slotOf(team, week, benchRb), "FLEX");
  });

  test("a locked player cannot be moved from one starting slot to another", async () => {
    const f = await buildLeague(db, "edge-flex-shuffle");
    const week = freshWeek();
    await game(week, "KC", "BUF", "-20 minutes");

    const rb = await player("Started RB", "RB", "KC");
    const team = f.teamIds[1];
    await roster(f, team, rb);
    await seat(f, team, week, rb, "RB");

    await db.actAs(f.managers[0]);
    await refuses(
      () => move(team, week, rb, "FLEX"),
      "locked",
      "RB -> FLEX is still a move after kickoff",
    );
    assert.equal(await slotOf(team, week, rb), "RB");
  });
});

// Two games in a week ---------------------------------------------------------

describe("an NFL team with two games in one week", () => {
  test("the player locks at the earlier kickoff, not the later one", async () => {
    const f = await buildLeague(db, "edge-doubleheader");
    const week = freshWeek();
    // A rescheduled fixture: KC plays twice in the same fantasy week.
    await game(week, "KC", "BUF", "-2 hours");
    await game(week, "LV", "KC", "2 days");

    const kc = await player("Busy KC WR", "WR", "KC");
    const team = f.teamIds[1];
    await roster(f, team, kc);
    await seat(f, team, week, kc, "WR");

    await db.actAs(f.managers[0]);

    const locks = await db.q<{ locks_at: string; locked: boolean }>(
      `select locks_at, locked from public.lineup_locks($1, $2, $3)
       where player_id = $4`,
      [team, SEASON, week, kc],
    );
    assert.equal(locks[0].locked, true, "the first of his two games has started");

    await refuses(
      () => move(team, week, kc, "BN"),
      "locked",
      "he cannot be pulled before the second game",
    );
  });

  test("a preseason fixture is not a kickoff", async () => {
    const f = await buildLeague(db, "edge-preseason");
    const week = freshWeek();
    await game(week, "KC", "BUF", "-2 hours", "PRE");
    await game(week, "KC", "DEN", "2 days", "REG");

    const kc = await player("Preseason KC WR", "WR", "KC");
    const team = f.teamIds[1];
    await roster(f, team, kc);
    await seat(f, team, week, kc, "WR");

    await db.actAs(f.managers[0]);
    assert.equal(await isLocked(team, week, kc), false);
    await move(team, week, kc, "BN");
    assert.equal(await slotOf(team, week, kc), "BN");
  });
});

// A schedule correction -------------------------------------------------------

describe("a kickoff time that changes after the lock", () => {
  test("once the job has stamped it, pushing the game back keeps him locked", async () => {
    const f = await buildLeague(db, "edge-reschedule-stamped");
    const week = freshWeek();
    const gid = await game(week, "KC", "BUF", "-1 hour");

    const wr = await player("Stamped WR", "WR", "KC");
    const team = f.teamIds[1];
    await roster(f, team, wr);
    await seat(f, team, week, wr, "WR");

    await runLockJob();

    const stamped = await db.asSuperuser(() =>
      db.q<{ locked_at: string | null }>(
        `select locked_at from public.lineup_entries
         where team_id = $1 and season = $2 and week = $3 and player_id = $4`,
        [team, SEASON, week, wr],
      ),
    );
    assert.ok(stamped[0].locked_at, "the job stamped the row");

    // The game is postponed to next weekend.
    await db.asSuperuser(() =>
      db.q(`update public.nfl_games set kickoff_at = now() + interval '5 days' where id = $1`, [gid]),
    );

    await db.actAs(f.managers[0]);
    assert.equal(await isLocked(team, week, wr), true, "the stamp stands on its own");
    await refuses(
      () => move(team, week, wr, "BN"),
      "locked",
      "a stamped lock survives a schedule correction",
    );
  });

  test("with no stamp yet, pushing the game back unlocks him again", async () => {
    const f = await buildLeague(db, "edge-reschedule-unstamped");
    const week = freshWeek();
    const gid = await game(week, "KC", "BUF", "-1 hour");

    const wr = await player("Unstamped WR", "WR", "KC");
    const team = f.teamIds[1];
    await roster(f, team, wr);
    await seat(f, team, week, wr, "WR");

    await db.actAs(f.managers[0]);
    assert.equal(await isLocked(team, week, wr), true);

    await db.asSuperuser(() =>
      db.q(`update public.nfl_games set kickoff_at = now() + interval '5 days' where id = $1`, [gid]),
    );

    assert.equal(await isLocked(team, week, wr), false, "no stamp, so the clock rules");
    await move(team, week, wr, "BN");
    assert.equal(await slotOf(team, week, wr), "BN");
  });

  test("a kickoff brought forward locks him without the job running", async () => {
    const f = await buildLeague(db, "edge-moved-up");
    const week = freshWeek();
    const gid = await game(week, "KC", "BUF", "2 days");

    const wr = await player("Moved-up WR", "WR", "KC");
    const team = f.teamIds[1];
    await roster(f, team, wr);
    await seat(f, team, week, wr, "WR");

    await db.actAs(f.managers[0]);
    await move(team, week, wr, "BN");

    await db.asSuperuser(() =>
      db.q(`update public.nfl_games set kickoff_at = now() - interval '5 minutes' where id = $1`, [gid]),
    );

    await refuses(
      () => move(team, week, wr, "WR"),
      "locked",
      "he cannot be started once the moved-up game has begun",
    );
  });
});

// weekly_kickoff and timezones -----------------------------------------------

describe("weekly_kickoff does not depend on the league's timezone", () => {
  test("two leagues in different zones lock on the same instant", async () => {
    const week = freshWeek();
    await game(week, "KC", "BUF", "-1 minute");
    await game(week, "DAL", "PHI", "2 days");

    const east = await buildLeague(
      db,
      "edge-tz-east",
      "lineup_lock_mode = 'weekly_kickoff', timezone = 'America/New_York'",
    );
    const pacific = await buildLeague(
      db,
      "edge-tz-pacific",
      "lineup_lock_mode = 'weekly_kickoff', timezone = 'Pacific/Auckland'",
    );

    for (const f of [east, pacific]) {
      const wr = await player("TZ WR", "WR", "DAL");
      const team = f.teamIds[1];
      await roster(f, team, wr);
      await seat(f, team, week, wr, "WR");

      await db.actAs(f.managers[0]);
      // The DAL game has not kicked off, but the week's first has.
      assert.equal(
        await isLocked(team, week, wr),
        true,
        "weekly_kickoff locks everybody at the week's first kickoff",
      );
      await refuses(() => move(team, week, wr, "BN"), "locked", "locked in both zones");
      await db.actAs(f.commish);
    }
  });

  test("a minute before the first kickoff, nothing is locked in either zone", async () => {
    const week = freshWeek();
    await game(week, "KC", "BUF", "1 minute");

    const f = await buildLeague(
      db,
      "edge-tz-ahead",
      "lineup_lock_mode = 'weekly_kickoff', timezone = 'Pacific/Honolulu'",
    );
    const wr = await player("Early TZ WR", "WR", "KC");
    const team = f.teamIds[1];
    await roster(f, team, wr);
    await seat(f, team, week, wr, "BN");

    await db.actAs(f.managers[0]);
    assert.equal(await isLocked(team, week, wr), false);
    await move(team, week, wr, "WR");
    assert.equal(await slotOf(team, week, wr), "WR");
  });
});

describe("the waiver clock across a DST change", () => {
  /**
   * last_waiver_run is the one piece of 0042 that does local-time
   * arithmetic, so it is the one that a DST change can move. A league
   * that processes waivers at 03:00 Wednesday should see 03:00 local on
   * both sides of the US spring-forward, not 02:00 or 04:00.
   */
  test("03:00 Wednesday stays 03:00 local on both sides of spring forward", async () => {
    const f = await buildLeague(
      db,
      "edge-dst",
      "timezone = 'America/New_York', waiver_process_dow = 3, waiver_process_time = '03:00'",
    );

    const rows = await db.asSuperuser(() =>
      db.q<{ before_run: string; after_run: string }>(
        `select
           to_char(public.last_waiver_run($1, '2027-03-12 12:00:00-05'::timestamptz)
                     at time zone 'America/New_York', 'YYYY-MM-DD HH24:MI') as before_run,
           to_char(public.last_waiver_run($1, '2027-03-19 12:00:00-04'::timestamptz)
                     at time zone 'America/New_York', 'YYYY-MM-DD HH24:MI') as after_run`,
        [f.leagueId],
      ),
    );

    // 2027-03-14 is the US spring-forward. The Wednesday before is the
    // 10th (EST), the Wednesday after is the 17th (EDT).
    assert.equal(rows[0].before_run, "2027-03-10 03:00", "the EST side");
    assert.equal(rows[0].after_run, "2027-03-17 03:00", "the EDT side");
  });

  test("and 03:00 Wednesday stays 03:00 across fall back", async () => {
    const f = await buildLeague(
      db,
      "edge-dst-fall",
      "timezone = 'America/New_York', waiver_process_dow = 3, waiver_process_time = '03:00'",
    );

    const rows = await db.asSuperuser(() =>
      db.q<{ before_run: string; after_run: string }>(
        `select
           to_char(public.last_waiver_run($1, '2026-10-29 12:00:00-04'::timestamptz)
                     at time zone 'America/New_York', 'YYYY-MM-DD HH24:MI') as before_run,
           to_char(public.last_waiver_run($1, '2026-11-05 12:00:00-05'::timestamptz)
                     at time zone 'America/New_York', 'YYYY-MM-DD HH24:MI') as after_run`,
        [f.leagueId],
      ),
    );

    assert.equal(rows[0].before_run, "2026-10-28 03:00", "the EDT side");
    assert.equal(rows[0].after_run, "2026-11-04 03:00", "the EST side");
  });
});

// A player who changes hands mid-week -----------------------------------------

describe("a player who changes hands after kickoff", () => {
  test("dropped and picked up by another team: he scores for the team that started him, and cannot start for the new one", async () => {
    const f = await buildLeague(db, "edge-rebound", "locked_players_to_waivers = false, waiver_period_hours = 0");
    const week = freshWeek();
    await game(week, "KC", "BUF", "-1 hour");

    const wr = await player("Rebound WR", "WR", "KC");
    const seller = f.teamIds[1];
    const buyer = f.teamIds[2];
    await roster(f, seller, wr);
    await seat(f, seller, week, wr, "WR");

    await db.asSuperuser(() =>
      db.q(`update public.leagues set current_week = $2 where id = $1`, [f.leagueId, week]),
    );

    // The seller drops him with his game under way.
    await db.actAs(f.managers[0]);
    await db.q("select public.drop_player($1, $2)", [seller, wr]);

    assert.equal(
      await slotOf(seller, week, wr),
      "WR",
      "his locked starting row stays with the team that started him",
    );

    // The buyer adds him; the league does not send started players to waivers.
    await db.actAs(f.managers[1]);
    await db.q("select public.add_free_agent($1, $2)", [buyer, wr]);

    const onBuyer = await db.asSuperuser(() =>
      db.q(
        `select 1 from public.roster_players
         where team_id = $1 and player_id = $2 and dropped_at is null`,
        [buyer, wr],
      ),
    );
    assert.equal(onBuyer.length, 1, "he is on the buyer's roster");

    // But he cannot be started for the buyer this week.
    await refuses(
      () =>
        db.q(
          `insert into public.lineup_entries
             (league_id, team_id, season, week, player_id, slot_key)
           values ($1, $2, $3, $4, $5, 'WR')`,
          [f.leagueId, buyer, SEASON, week, wr],
        ),
      "locked",
      "the buyer cannot start a player whose game has begun",
    );

    // The bench is fine: he scores nothing there.
    await db.q(
      `insert into public.lineup_entries
         (league_id, team_id, season, week, player_id, slot_key)
       values ($1, $2, $3, $4, $5, 'BN')`,
      [f.leagueId, buyer, SEASON, week, wr],
    );
    assert.equal(await slotOf(buyer, week, wr), "BN");

    // And the seller still cannot take his row out.
    await db.actAs(f.managers[0]);
    await refuses(
      () =>
        db.q(
          `delete from public.lineup_entries
           where team_id = $1 and season = $2 and week = $3 and player_id = $4`,
          [seller, SEASON, week, wr],
        ),
      "locked",
      "the seller is stuck with the points he started",
    );
  });

  test("the buyer can start him the following week", async () => {
    const f = await buildLeague(db, "edge-rebound-next", "locked_players_to_waivers = false, waiver_period_hours = 0");
    const week = freshWeek();
    const next = freshWeek();
    await game(week, "KC", "BUF", "-1 hour");
    await game(next, "KC", "DEN", "5 days");

    const wr = await player("Next-week WR", "WR", "KC");
    const seller = f.teamIds[1];
    const buyer = f.teamIds[2];
    await roster(f, seller, wr);
    await seat(f, seller, week, wr, "WR");
    await db.asSuperuser(() =>
      db.q(`update public.leagues set current_week = $2 where id = $1`, [f.leagueId, week]),
    );

    await db.actAs(f.managers[0]);
    await db.q("select public.drop_player($1, $2)", [seller, wr]);
    await db.actAs(f.managers[1]);
    await db.q("select public.add_free_agent($1, $2)", [buyer, wr]);

    await db.q(
      `insert into public.lineup_entries
         (league_id, team_id, season, week, player_id, slot_key)
       values ($1, $2, $3, $4, $5, 'WR')`,
      [f.leagueId, buyer, SEASON, next, wr],
    );
    assert.equal(await slotOf(buyer, next, wr), "WR", "next week is a clean sheet");
  });

  test("a trade mid-week leaves the locked week behind and opens the next one", async () => {
    const f = await buildLeague(db, "edge-trade-midweek");
    const week = freshWeek();
    const next = freshWeek();
    await game(week, "KC", "BUF", "-1 hour");
    await game(next, "KC", "DEN", "5 days");

    const locked = await player("Traded locked WR", "WR", "KC");
    const free = await player("Traded free RB", "RB", "DAL");
    await game(week, "DAL", "PHI", "2 days");

    const from = f.teamIds[1];
    const to = f.teamIds[2];
    await roster(f, from, locked);
    await roster(f, from, free);
    await seat(f, from, week, locked, "WR");
    await seat(f, from, week, free, "RB");
    await seat(f, from, next, locked, "WR");

    await db.asSuperuser(() =>
      db.q(`update public.leagues set current_week = $2 where id = $1`, [f.leagueId, week]),
    );

    await db.actAs(f.managers[0]);
    // An agreed trade, written as the system: the paths that propose and
    // accept one are not what is under test here.
    const trade = await db.asSuperuser(() =>
      db.one<{ id: string }>(
        `insert into public.trades
           (league_id, proposing_team_id, receiving_team_id, season, week, status)
         values ($1, $2, $3, $4, $5, 'accepted') returning id`,
        [f.leagueId, from, to, SEASON, week],
      ),
    );
    for (const p of [locked, free]) {
      await db.asSuperuser(() =>
        db.q(
          `insert into public.trade_items (trade_id, from_team_id, player_id)
           values ($1, $2, $3)`,
          [trade.id, from, p],
        ),
      );
    }

    await db.q("select public.execute_trade($1)", [trade.id]);

    assert.equal(await slotOf(from, week, locked), "WR", "the locked week stays put");
    assert.equal(await slotOf(from, week, free), null, "the unlocked starter is cleared");
    assert.equal(await slotOf(from, next, locked), null, "next week goes with him");
  });
});

// Saving twice, and saving into a kickoff ------------------------------------

describe("a save that is sent twice", () => {
  test("the second save of the same form writes nothing and does not error", async () => {
    const f = await buildLeague(db, "edge-double-submit");
    const week = freshWeek();
    await game(week, "DAL", "PHI", "2 days");

    const a = await player("Double A", "WR", "DAL");
    const b = await player("Double B", "WR", "DAL");
    const team = f.teamIds[1];
    await roster(f, team, a);
    await roster(f, team, b);
    await seat(f, team, week, a, "WR");
    await seat(f, team, week, b, "BN");

    await db.actAs(f.managers[0]);

    const slots = await db.q<{
      slot_key: string;
      count: number;
      is_starter: boolean;
      eligible_positions: string[];
    }>(
      `select slot_key, count, is_starter, eligible_positions
       from public.roster_slots where league_id = $1`,
      [f.leagueId],
    );

    async function planAndApply(submitted: Map<string, string>) {
      const lineup = await db.q<{ player_id: string; slot_key: string }>(
        `select player_id, slot_key from public.lineup_entries
         where team_id = $1 and season = $2 and week = $3`,
        [team, SEASON, week],
      );
      const locks = await db.q<{ player_id: string; locked: boolean }>(
        `select player_id, locked from public.lineup_locks($1, $2, $3)`,
        [team, SEASON, week],
      );

      const plan = planLineupSave({
        week,
        lockMode: "per_player",
        slots,
        current: new Map(lineup.map((r) => [r.player_id, r.slot_key])),
        locked: new Set(locks.filter((l) => l.locked).map((l) => l.player_id)),
        roster: new Map([
          [a, "WR"],
          [b, "WR"],
        ]),
        names: new Map(),
        submitted,
      });
      if ("error" in plan) return plan;

      if (plan.deletes.length > 0) {
        await db.q(
          `delete from public.lineup_entries
           where team_id = $1 and season = $2 and week = $3 and player_id = any($4)`,
          [team, SEASON, week, plan.deletes],
        );
      }
      for (const u of plan.upserts) {
        await db.q(
          `insert into public.lineup_entries
             (league_id, team_id, season, week, player_id, slot_key)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (team_id, season, week, player_id)
             do update set slot_key = excluded.slot_key`,
          [f.leagueId, team, SEASON, week, u.playerId, u.slotKey],
        );
      }
      return plan;
    }

    // The manager swaps A to the bench and B into WR, and the request
    // lands twice.
    const submitted = new Map([
      [a, "BN"],
      [b, "WR"],
    ]);

    const first = await planAndApply(submitted);
    assert.ok(!("error" in first), "the first save goes through");

    const second = await planAndApply(submitted);
    assert.deepEqual(
      second,
      { upserts: [], deletes: [] },
      "the second save has nothing left to do",
    );

    assert.equal(await slotOf(team, week, a), "BN");
    assert.equal(await slotOf(team, week, b), "WR");
  });
});

describe("a save that races the lock job", () => {
  test("a swap planned before kickoff is refused whole, not half-written", async () => {
    const f = await buildLeague(db, "edge-race");
    const week = freshWeek();
    const gid = await game(week, "KC", "BUF", "30 minutes");

    const starter = await player("Race starter", "WR", "KC");
    const bench = await player("Race bench", "WR", "KC");
    const team = f.teamIds[1];
    await roster(f, team, starter);
    await roster(f, team, bench);
    await seat(f, team, week, starter, "WR");
    await seat(f, team, week, bench, "BN");

    await db.actAs(f.managers[0]);

    // Planned while nothing was locked.
    const plan = planLineupSave({
      week,
      lockMode: "per_player",
      slots: [
        { slot_key: "WR", count: 2, is_starter: true, eligible_positions: ["WR"] },
        { slot_key: "BN", count: 7, is_starter: false, eligible_positions: [] },
      ],
      current: new Map([
        [starter, "WR"],
        [bench, "BN"],
      ]),
      locked: new Set(),
      roster: new Map([
        [starter, "WR"],
        [bench, "WR"],
      ]),
      names: new Map(),
      submitted: new Map([
        [starter, "BN"],
        [bench, "WR"],
      ]),
    });
    assert.ok(!("error" in plan));

    // The game kicks off in the gap between planning and writing.
    await db.asSuperuser(() =>
      db.q(`update public.nfl_games set kickoff_at = now() - interval '1 minute' where id = $1`, [gid]),
    );

    // The real action sends one upsert statement, so the whole swap is
    // refused together.
    await refuses(
      () =>
        db.q(
          `insert into public.lineup_entries
             (league_id, team_id, season, week, player_id, slot_key)
           select $1, $2, $3, $4, u.player_id, u.slot_key
           from (values ($5::text, $6::text), ($7::text, $8::text)) as u(player_id, slot_key)
           on conflict (team_id, season, week, player_id)
             do update set slot_key = excluded.slot_key`,
          [
            f.leagueId,
            team,
            SEASON,
            week,
            (plan as { upserts: { playerId: string; slotKey: string }[] }).upserts[0].playerId,
            (plan as { upserts: { playerId: string; slotKey: string }[] }).upserts[0].slotKey,
            (plan as { upserts: { playerId: string; slotKey: string }[] }).upserts[1].playerId,
            (plan as { upserts: { playerId: string; slotKey: string }[] }).upserts[1].slotKey,
          ],
        ),
      "locked",
      "the race is refused",
    );

    assert.equal(await slotOf(team, week, starter), "WR", "nothing moved");
    assert.equal(await slotOf(team, week, bench), "BN", "nothing moved");
  });

  test("the lock job running twice stamps nothing new the second time", async () => {
    const f = await buildLeague(db, "edge-job-twice");
    const week = freshWeek();
    await game(week, "KC", "BUF", "-1 hour");
    const wr = await player("Job WR", "WR", "KC");
    const team = f.teamIds[1];
    await roster(f, team, wr);
    await seat(f, team, week, wr, "WR");

    const first = await runLockJob();
    assert.ok(Number(first.locked) >= 1, "the first run stamps him");
    const second = await runLockJob();
    assert.equal(Number(second.locked), 0, "the second run has nothing to stamp");
  });
});

// A commissioner reaching across leagues --------------------------------------

describe("the commissioner's override stays in his own league", () => {
  test("a commissioner of one league cannot override a team in another", async () => {
    const mine = await buildLeague(db, "edge-xleague-mine");
    const theirs = await buildLeague(db, "edge-xleague-theirs");
    const week = freshWeek();
    await game(week, "KC", "BUF", "-1 hour");

    const wr = await player("Other league WR", "WR", "KC");
    const theirTeam = theirs.teamIds[1];
    await roster(theirs, theirTeam, wr);
    await seat(theirs, theirTeam, week, wr, "WR");
    await db.asSuperuser(() =>
      db.q(`update public.leagues set current_week = $2 where id = $1`, [theirs.leagueId, week]),
    );

    // The commissioner of a completely different league.
    await db.actAs(mine.commish);
    await refuses(
      () =>
        db.q("select public.commissioner_set_lineup_slot($1, $2, $3, $4, $5)", [
          theirTeam,
          week,
          wr,
          "BN",
          "I run a different league",
        ]),
      "Only the commissioner can override a lineup",
      "a foreign commissioner is refused",
    );
    assert.equal(await slotOf(theirTeam, week, wr), "WR", "nothing moved");

    // A plain manager in that league is refused too.
    await db.actAs(theirs.managers[0]);
    await refuses(
      () =>
        db.q("select public.commissioner_set_lineup_slot($1, $2, $3, $4, $5)", [
          theirTeam,
          week,
          wr,
          "BN",
          "Let me out of this",
        ]),
      "Only the commissioner can override a lineup",
      "a manager is refused",
    );

    // Their own commissioner can.
    await db.actAs(theirs.commish);
    await db.q("select public.commissioner_set_lineup_slot($1, $2, $3, $4, $5)", [
      theirTeam,
      week,
      wr,
      "BN",
      "Wrong player started, fixing it",
    ]);
    assert.equal(await slotOf(theirTeam, week, wr), "BN");

    const logged = await db.q<{ note: string; type: string }>(
      `select type, note from public.transactions
       where league_id = $1 and player_id = $2 and type = 'commissioner'`,
      [theirs.leagueId, wr],
    );
    assert.equal(logged.length, 1, "one transaction row");
    assert.match(logged[0].note, /Reason: Wrong player started, fixing it/);
  });

  test("an override does not leave the bypass flag on for the next write", async () => {
    const f = await buildLeague(db, "edge-override-flag");
    const week = freshWeek();
    await game(week, "KC", "BUF", "-1 hour");

    const a = await player("Flag A", "WR", "KC");
    const b = await player("Flag B", "WR", "KC");
    const team = f.teamIds[0]; // the commissioner's own team
    await roster(f, team, a);
    await roster(f, team, b);
    await seat(f, team, week, a, "WR");
    await seat(f, team, week, b, "BN");
    await db.asSuperuser(() =>
      db.q(`update public.leagues set current_week = $2 where id = $1`, [f.leagueId, week]),
    );

    await db.actAs(f.commish);
    await db.q("select public.commissioner_set_lineup_slot($1, $2, $3, $4, $5)", [
      team,
      week,
      a,
      "BN",
      "Benching him after the fact",
    ]);

    // Right after a legitimate override, an ordinary write must still be
    // refused -- the flag is turned back off.
    await refuses(
      () => move(team, week, b, "WR"),
      "locked",
      "the override flag does not linger",
    );
  });
});

// locked_players_to_waivers off ----------------------------------------------

describe("locked_players_to_waivers off", () => {
  test("a started free agent joins the bench, and the lineup trigger is what stops him starting", async () => {
    const f = await buildLeague(db, "edge-waivers-off", "locked_players_to_waivers = false");
    const week = freshWeek();
    await game(week, "KC", "BUF", "-1 hour");

    const wr = await player("FA started WR", "WR", "KC");
    const team = f.teamIds[1];
    await db.asSuperuser(() =>
      db.q(`update public.leagues set current_week = $2 where id = $1`, [f.leagueId, week]),
    );

    await db.actAs(f.managers[0]);
    const onWaivers = await db.one<{ on_waivers: boolean }>(
      "select public.player_on_waivers($1, $2) as on_waivers",
      [f.leagueId, wr],
    );
    assert.equal(onWaivers.on_waivers, false, "not on waivers with the setting off");

    await db.q("select public.add_free_agent($1, $2)", [team, wr]);

    await db.q(
      `insert into public.lineup_entries
         (league_id, team_id, season, week, player_id, slot_key)
       values ($1, $2, $3, $4, $5, 'BN')`,
      [f.leagueId, team, SEASON, week, wr],
    );
    assert.equal(await slotOf(team, week, wr), "BN");

    await refuses(
      () => move(team, week, wr, "WR"),
      "locked",
      "he cannot be started",
    );
  });

  test("with it on, the same add is refused and points at waivers", async () => {
    const f = await buildLeague(db, "edge-waivers-on");
    const week = freshWeek();
    await game(week, "KC", "BUF", "-1 hour");

    const wr = await player("FA waivered WR", "WR", "KC");
    const team = f.teamIds[1];
    await db.asSuperuser(() =>
      db.q(`update public.leagues set current_week = $2 where id = $1`, [f.leagueId, week]),
    );

    await db.actAs(f.managers[0]);
    await refuses(
      () => db.q("select public.add_free_agent($1, $2)", [team, wr]),
      "on waivers until waivers next run",
      "the add is refused with the reason",
    );
  });

  test("the job holds him only in the leagues that want it", async () => {
    const week = freshWeek();
    await game(week, "KC", "BUF", "-1 hour");
    const on = await buildLeague(db, "edge-hold-on");
    const off = await buildLeague(db, "edge-hold-off", "locked_players_to_waivers = false");
    const wr = await player("Hold WR", "WR", "KC");

    await runLockJob();

    const held = await db.asSuperuser(() =>
      db.q<{ league_id: string; until_waivers_run: boolean }>(
        `select league_id, until_waivers_run from public.waiver_holds where player_id = $1`,
        [wr],
      ),
    );
    const leagues = held.map((h) => h.league_id);
    assert.ok(leagues.includes(on.leagueId), "the opted-in league holds him");
    assert.ok(!leagues.includes(off.leagueId), "the opted-out league does not");
    assert.ok(
      held.filter((h) => h.league_id === on.leagueId).every((h) => h.until_waivers_run),
      "flagged as an until-the-next-run hold",
    );
  });
});

// A rule change in the middle of a locked week --------------------------------

describe("the commissioner changes the roster slots mid-week", () => {
  /**
   * is_starter_slot reads roster_slots, so what counts as a starting
   * slot is whatever the league says right now. A commissioner who
   * turns a starting slot into a bench slot (or deletes it) therefore
   * unlocks everybody in it -- and team_week_points stops counting
   * them -- without going through the logged override.
   */
  test("turning a starting slot into a bench slot unlocks the players in it", async () => {
    const f = await buildLeague(db, "edge-slot-change");
    const week = freshWeek();
    await game(week, "KC", "BUF", "-1 hour");

    const wr = await player("Rule-change WR", "WR", "KC");
    const team = f.teamIds[1];
    await roster(f, team, wr);
    await seat(f, team, week, wr, "WR");

    await db.actAs(f.managers[0]);
    await refuses(() => move(team, week, wr, "BN"), "locked", "locked to start with");

    // The commissioner edits the roster settings mid-week.
    await db.actAs(f.commish);
    await db.q(
      `update public.roster_slots set is_starter = false
       where league_id = $1 and slot_key = 'WR'`,
      [f.leagueId],
    );

    await db.actAs(f.managers[0]);
    assert.equal(
      await isLocked(team, week, wr),
      true,
      "lineup_locks still calls him locked -- it is about his kickoff, not his slot",
    );
    // But the trigger only guards starting slots, so he moves freely.
    await move(team, week, wr, "BN");
    assert.equal(
      await slotOf(team, week, wr),
      "BN",
      "a slot that is no longer a starting slot is no longer guarded",
    );
  });

  test("a stamped lock keeps a starting slot guarded through the change", async () => {
    const f = await buildLeague(db, "edge-slot-change-stamped");
    const week = freshWeek();
    await game(week, "KC", "BUF", "-1 hour");

    const wr = await player("Stamped rule-change WR", "WR", "KC");
    const team = f.teamIds[1];
    await roster(f, team, wr);
    await seat(f, team, week, wr, "WR");
    await runLockJob();

    // Narrowing WR from two places to one does not let him out.
    await db.actAs(f.commish);
    await db.q(
      `update public.roster_slots set count = 1
       where league_id = $1 and slot_key = 'WR'`,
      [f.leagueId],
    );

    await db.actAs(f.managers[0]);
    await refuses(() => move(team, week, wr, "BN"), "locked", "still guarded");
  });
});

// A slot key the league does not have ----------------------------------------

describe("a slot key the league does not have", () => {
  test("it counts as the bench: a locked player can be parked there, and scores nothing", async () => {
    const f = await buildLeague(db, "edge-bogus-slot");
    const week = freshWeek();
    await game(week, "KC", "BUF", "-1 hour");

    const wr = await player("Bogus slot WR", "WR", "KC");
    const team = f.teamIds[1];
    await roster(f, team, wr);
    await db.asSuperuser(() =>
      db.q(
        `insert into public.player_week_scores
           (league_id, player_id, season, week, points, is_final)
         values ($1, $2, $3, $4, 9.5, true)`,
        [f.leagueId, wr, SEASON, week],
      ),
    );

    await db.actAs(f.managers[0]);
    // A hand-rolled write with a slot nobody defined. The lock trigger
    // treats it as the bench, which is the same test team_week_points
    // uses, so it cannot be used to smuggle points onto the board.
    await db.q(
      `insert into public.lineup_entries
         (league_id, team_id, season, week, player_id, slot_key)
       values ($1, $2, $3, $4, $5, 'SUPERFLEX')`,
      [f.leagueId, team, SEASON, week, wr],
    );

    const points = await db.q<{ points: string }>(
      `select points from public.team_week_points($1, $2, $3) where team_id = $4`,
      [f.leagueId, SEASON, week, team],
    );
    assert.equal(points.length, 0, "an undefined slot scores nothing");

    // And he can still be taken out of it, because it is not a starter.
    await db.q(
      `delete from public.lineup_entries
       where team_id = $1 and season = $2 and week = $3 and player_id = $4`,
      [team, SEASON, week, wr],
    );
    assert.equal(await slotOf(team, week, wr), null);
  });
});

// A dropped locked starter, and the views that should still show him --------

describe("a locked starter who has been dropped", () => {
  /**
   * internal_drop deliberately keeps his starting row: his points are
   * already on the board and the trigger will not let anybody take them
   * off. team_week_points therefore still counts him -- it joins
   * lineup_entries to the starter slots and never looks at the roster.
   *
   * getTeamRoster reads roster_players where dropped_at is null, which
   * on its own leaves him out and left his slot reading empty while the
   * matchup and the standings counted his points. It now adds the
   * players lineup_locks reports as locked into the week but no longer
   * held, marked onRoster false, so every view draws him.
   */
  test("his points still count for the team, and the week's lineup still holds him", async () => {
    const f = await buildLeague(db, "edge-dropped-starter", "waiver_period_hours = 0");
    const week = freshWeek();
    await game(week, "KC", "BUF", "-2 hours");
    await game(week, "DAL", "PHI", "4 hours");

    const dropped = await player("Dropped starter WR", "WR", "KC");
    const kept = await player("Kept starter WR", "WR", "DAL");
    const team = f.teamIds[1];
    await roster(f, team, dropped);
    await roster(f, team, kept);
    await seat(f, team, week, dropped, "WR");
    await seat(f, team, week, kept, "WR");

    await db.asSuperuser(() =>
      db.q(`update public.leagues set current_week = $2 where id = $1`, [f.leagueId, week]),
    );
    for (const [p, pts] of [
      [dropped, 18.5],
      [kept, 4],
    ] as [string, number][]) {
      await db.asSuperuser(() =>
        db.q(
          `insert into public.player_week_scores
             (league_id, player_id, season, week, points, is_final)
           values ($1, $2, $3, $4, $5, true)`,
          [f.leagueId, p, SEASON, week, pts],
        ),
      );
    }

    await db.actAs(f.managers[0]);
    await db.q("select public.drop_player($1, $2)", [team, dropped]);

    assert.equal(await slotOf(team, week, dropped), "WR", "his locked row stays");

    const points = await db.one<{ points: string }>(
      `select points from public.team_week_points($1, $2, $3) where team_id = $4`,
      [f.leagueId, SEASON, week, team],
    );
    assert.equal(
      Number(points.points),
      22.5,
      "the team is still scored for the player it started",
    );

    // lineup_locks keeps him, so the save planner can leave his row alone.
    const locks = await db.q<{ player_id: string; locked: boolean }>(
      `select player_id, locked from public.lineup_locks($1, $2, $3)`,
      [team, SEASON, week],
    );
    assert.ok(
      locks.filter((l) => l.locked).map((l) => l.player_id).includes(dropped),
      "lineup_locks still returns him",
    );

    // The roster alone leaves him out...
    const held = await db.q<{ player_id: string }>(
      `select player_id from public.roster_players
       where team_id = $1 and dropped_at is null`,
      [team],
    );
    assert.deepEqual(held.map((r) => r.player_id), [kept]);

    // ...so getTeamRoster adds back whoever the week is still holding:
    // a lineup row, with his player record, for somebody not on the
    // roster and locked. This is the query it runs.
    const drawn = await db.q<{ player_id: string; full_name: string; slot_key: string }>(
      `select le.player_id, p.full_name, le.slot_key
       from public.lineup_entries le
       join public.nfl_players p on p.id = le.player_id
       join public.lineup_locks($1, $2, $3) lk on lk.player_id = le.player_id
       where le.team_id = $1 and le.season = $2 and le.week = $3
         and lk.locked
         and not exists (
           select 1 from public.roster_players rp
           where rp.team_id = $1 and rp.player_id = le.player_id
             and rp.dropped_at is null
         )`,
      [team, SEASON, week],
    );
    assert.deepEqual(
      drawn.map((r) => [r.full_name, r.slot_key]),
      [["Dropped starter WR", "WR"]],
      "he is drawn in the WR slot he is locked into",
    );

    // Which makes the starters on screen add up to what the team is
    // scored: the team page sums the entries sitting in starter slots.
    const shown = await db.q<{ total: string }>(
      `select coalesce(sum(pws.points), 0) as total
       from public.lineup_entries le
       join public.roster_slots rs
         on rs.league_id = le.league_id and rs.slot_key = le.slot_key and rs.is_starter
       left join public.player_week_scores pws
         on pws.league_id = le.league_id and pws.season = le.season
        and pws.week = le.week and pws.player_id = le.player_id
       where le.team_id = $1 and le.season = $2 and le.week = $3`,
      [team, SEASON, week],
    );
    assert.equal(Number(shown[0].total), 22.5, "22.5 on screen, 22.5 in the standings");
  });

  test("the commissioner can still reach a team whose only week-row is the dropped starter", async () => {
    const f = await buildLeague(db, "edge-dropped-only", "waiver_period_hours = 0");
    const week = freshWeek();
    await game(week, "KC", "BUF", "-2 hours");

    const dropped = await player("Only starter WR", "WR", "KC");
    const team = f.teamIds[1];
    await roster(f, team, dropped);
    await seat(f, team, week, dropped, "WR");
    await db.asSuperuser(() =>
      db.q(`update public.leagues set current_week = $2 where id = $1`, [f.leagueId, week]),
    );

    await db.actAs(f.managers[0]);
    await db.q("select public.drop_player($1, $2)", [team, dropped]);

    // The roster is empty, so the team page used to hide the override
    // panel (it is gated on there being somebody to pick). He is in
    // what getTeamRoster returns now, so the panel is drawn...
    const drawn = await db.q<{ player_id: string; locked: boolean }>(
      `select lk.player_id, lk.locked
       from public.lineup_locks($1, $2, $3) lk
       join public.lineup_entries le
         on le.player_id = lk.player_id and le.team_id = $1
        and le.season = $2 and le.week = $3`,
      [team, SEASON, week],
    );
    assert.deepEqual(drawn, [{ player_id: dropped, locked: true }]);

    // ...and the override itself works on him: he is not on the roster,
    // but he is in the week's lineup, which is what the RPC accepts.
    await db.actAs(f.commish);
    await db.q("select public.commissioner_set_lineup_slot($1, $2, $3, $4, $5)", [
      team, week, dropped, "BN", "dropped by mistake, not played",
    ]);
    assert.equal(await slotOf(team, week, dropped), "BN");

    const log = await db.q<{ note: string }>(
      `select note from public.transactions
       where team_id = $1 and type = 'commissioner'`,
      [team],
    );
    assert.equal(log.length, 1);
    assert.ok(log[0].note.includes("from WR to BN"), log[0].note);
  });
});

// The editor's board after a locked starter is dropped ------------------------

describe("the editor's board when a locked starter has been dropped", () => {
  /**
   * getTeamRoster returns a dropped locked starter as an onRoster-false
   * entry, so the editor seeds him into the slot he is locked into. The
   * board and planLineupSave then agree about what is in the WR slots,
   * which is what the "3 of 2" refusal used to contradict.
   */
  const slotDefs: RosterSlot[] = [
    { id: "1", league_id: "l", slot_key: "WR", label: "WR", eligible_positions: ["WR"], count: 2, is_starter: true, order_index: 30 },
    { id: "2", league_id: "l", slot_key: "BN", label: "Bench", eligible_positions: [], count: 7, is_starter: false, order_index: 80 },
  ] as RosterSlot[];

  const saveSlots = [
    { slot_key: "WR", count: 2, is_starter: true, eligible_positions: ["WR"] },
    { slot_key: "BN", count: 7, is_starter: false, eligible_positions: [] },
  ];

  /** The editor's seeding of `placed`, as my-team/editor.tsx does it. */
  function seedBoard(
    spots: LineupSpot[],
    roster: { playerId: string; slotKey: string | null; points: number; locked: boolean; position: string }[],
  ) {
    const placed: Record<string, string | null> = {};
    const remaining = new Map<string, string[]>();
    for (const entry of roster) {
      if (!entry.slotKey) continue;
      const list = remaining.get(entry.slotKey) ?? [];
      list.push(entry.playerId);
      remaining.set(entry.slotKey, list);
    }
    for (const spot of spots) {
      placed[spot.key] = remaining.get(spot.slotKey)?.shift() ?? null;
    }
    return autoFill(
      placed,
      spots,
      roster.map((r) => ({
        playerId: r.playerId,
        points: r.points,
        player: { position: r.position },
        locked: r.locked,
      })),
    );
  }

  /**
   * WR1 and WR2 both started and both kicked off; WR1 has since been
   * dropped, so he comes back from the lineup rather than the roster.
   * WR3 is on the bench.
   */
  const roster = [
    { playerId: "wr1", slotKey: "WR", points: 18.5, locked: true, position: "WR" },
    { playerId: "wr2", slotKey: "WR", points: 12, locked: true, position: "WR" },
    { playerId: "wr3", slotKey: "BN", points: 0, locked: false, position: "WR" },
  ];

  const current = new Map([
    ["wr1", "WR"],
    ["wr2", "WR"],
    ["wr3", "BN"],
  ]);

  function plan(submitted: Map<string, string>) {
    return planLineupSave({
      week: 3,
      lockMode: "per_player",
      slots: saveSlots,
      current,
      locked: new Set(["wr1", "wr2"]),
      // The dropped starter is in what the editor draws, so the form
      // sends him back too; the planner leaves his row alone either way.
      roster: new Map([
        ["wr1", "WR"],
        ["wr2", "WR"],
        ["wr3", "WR"],
      ]),
      names: new Map([["wr1", "Dropped Starter"]]),
      submitted,
    });
  }

  test("he is drawn in the slot he holds, so no starting spot reads empty", () => {
    const spots = expandSlots(slotDefs);
    const placed = seedBoard(spots, roster);

    assert.deepEqual(
      [placed["WR-0"], placed["WR-1"]],
      ["wr1", "wr2"],
      "both locked receivers are on the board",
    );
    assert.equal(placed["BN-0"], "wr3");

    const emptyStarters = spots.filter((s) => s.isStarter && !placed[s.key]).length;
    assert.equal(emptyStarters, 0, "no red 'empty' pill, and nothing to fill");

    // And the sum on screen is the sum the team is scored.
    const shown = spots
      .filter((s) => s.isStarter)
      .reduce(
        (total, s) =>
          total + (roster.find((r) => r.playerId === placed[s.key])?.points ?? 0),
        0,
      );
    assert.equal(shown, 30.5);
  });

  test("the board as drawn saves cleanly, and never rewrites his row", () => {
    const kept = plan(new Map([["wr1", "WR"], ["wr2", "WR"], ["wr3", "BN"]]));
    assert.deepEqual(kept, { upserts: [], deletes: [] });
  });

  /*
   * Both WR slots are now drawn as taken by locked players, so the
   * editor never offers this move -- the spots' buttons are disabled.
   * A stale tab can still send it, and it is still refused, but every
   * player it counts is now one the manager can see on the board.
   */
  test("a third receiver is still refused, and now the two in the way are on screen", () => {
    const filled = plan(new Map([["wr2", "WR"], ["wr3", "WR"]]));
    assert.deepEqual(filled, { error: "Too many players at WR: 3 of 2." });

    const spots = expandSlots(slotDefs);
    const placed = seedBoard(spots, roster);
    const inTheWay = spots
      .filter((s) => s.slotKey === "WR")
      .map((s) => placed[s.key]);
    assert.deepEqual(inTheWay, ["wr1", "wr2"]);
  });
});
