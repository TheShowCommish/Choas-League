/**
 * Row level security tests.
 *
 * These are the load-bearing security guarantees of the whole app:
 *
 *   - you can only see leagues you belong to
 *   - you can only control your own team
 *   - nobody can see anybody else's pending waiver bid
 *
 * The other suites run as superuser, which bypasses RLS entirely, so
 * none of that is actually exercised there. Here the connection runs as
 * the `authenticated` role with FORCE ROW LEVEL SECURITY on every table,
 * which is as close to how Supabase runs it as PGlite gets.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, type TestDb } from "./lib/test-db.ts";
import { SEASON } from "./lib/fixtures.ts";

let db: TestDb;

interface Actor {
  userId: string;
  teamId: string;
}

interface TwoLeagues {
  /** Commissioner and a manager in league A. */
  alice: Actor;
  bob: Actor;
  /** A manager in an entirely separate league. */
  mallory: Actor;
  leagueA: string;
  leagueB: string;
}

let world: TwoLeagues;

before(async () => {
  db = await createTestDb({ enforceRls: true });

  const aliceId = await db.createUser("alice@example.com", "Alice");
  const bobId = await db.createUser("bob@example.com", "Bob");
  const malloryId = await db.createUser("mallory@example.com", "Mallory");

  // League A, run by Alice, with Bob as a manager.
  await db.actAs(aliceId);
  const a = await db.one<{ id: string; join_code: string }>(
    `insert into public.leagues (name, season, commissioner_id)
     values ('League A', $1, $2) returning id, join_code`,
    [SEASON, aliceId],
  );
  const aliceTeam = await db.one<{ join_league: string }>(
    "select public.join_league($1, $2) as join_league",
    [a.join_code, "Alice FC"],
  );

  await db.actAs(bobId);
  const bobTeam = await db.one<{ join_league: string }>(
    "select public.join_league($1, $2) as join_league",
    [a.join_code, "Bob United"],
  );

  // League B, a completely separate league Mallory belongs to.
  await db.actAs(malloryId);
  const b = await db.one<{ id: string; join_code: string }>(
    `insert into public.leagues (name, season, commissioner_id)
     values ('League B', $1, $2) returning id, join_code`,
    [SEASON, malloryId],
  );
  const malloryTeam = await db.one<{ join_league: string }>(
    "select public.join_league($1, $2) as join_league",
    [b.join_code, "Mallory Town"],
  );

  world = {
    alice: { userId: aliceId, teamId: aliceTeam.join_league },
    bob: { userId: bobId, teamId: bobTeam.join_league },
    mallory: { userId: malloryId, teamId: malloryTeam.join_league },
    leagueA: a.id,
    leagueB: b.id,
  };

  // A player for the roster tests.
  await db.asSuperuser(async () => {
    await db.q(
      `insert into public.nfl_players (id, full_name, position, team_abbr)
       values ('RLS_WR', 'Test Receiver', 'WR', 'KC')
       on conflict (id) do nothing`,
    );
  });
});

after(async () => {
  await db.close();
});

describe("league visibility", () => {
  test("you only see leagues you belong to", async () => {
    await db.actAs(world.alice.userId);
    const alicesLeagues = await db.q<{ name: string }>(
      "select name from public.leagues order by name",
    );
    assert.deepEqual(alicesLeagues.map((l) => l.name), ["League A"]);

    await db.actAs(world.mallory.userId);
    const mallorysLeagues = await db.q<{ name: string }>(
      "select name from public.leagues order by name",
    );
    assert.deepEqual(mallorysLeagues.map((l) => l.name), ["League B"]);
  });

  test("an outsider cannot read another league's teams", async () => {
    await db.actAs(world.mallory.userId);

    const teams = await db.q(
      "select id from public.teams where league_id = $1",
      [world.leagueA],
    );
    assert.equal(teams.length, 0, "League A is invisible to Mallory");
  });

  test("an outsider cannot read another league's transaction log", async () => {
    await db.asSuperuser(async () => {
      await db.q(
        `insert into public.transactions
           (league_id, team_id, type, player_id, season, week)
         values ($1, $2, 'add', 'RLS_WR', $3, 1)`,
        [world.leagueA, world.bob.teamId, SEASON],
      );
    });

    await db.actAs(world.bob.userId);
    const mine = await db.q(
      "select id from public.transactions where league_id = $1",
      [world.leagueA],
    );
    assert.equal(mine.length, 1, "Bob sees his own league's log");

    await db.actAs(world.mallory.userId);
    const theirs = await db.q(
      "select id from public.transactions where league_id = $1",
      [world.leagueA],
    );
    assert.equal(theirs.length, 0, "Mallory sees nothing");
  });

  test("league members can see each other's teams", async () => {
    await db.actAs(world.bob.userId);
    const teams = await db.q<{ name: string }>(
      "select name from public.teams where league_id = $1 order by name",
      [world.leagueA],
    );
    assert.deepEqual(teams.map((t) => t.name), ["Alice FC", "Bob United"]);
  });
});

describe("team control", () => {
  test("you cannot rename somebody else's team", async () => {
    await db.actAs(world.bob.userId);

    await db.q("update public.teams set name = $1 where id = $2", [
      "Hijacked",
      world.alice.teamId,
    ]);

    // The policy filters the row out rather than raising, so the update
    // silently matches nothing -- which is the correct outcome.
    await db.actAs(world.alice.userId);
    const team = await db.one<{ name: string }>(
      "select name from public.teams where id = $1",
      [world.alice.teamId],
    );
    assert.equal(team.name, "Alice FC", "Alice's team is untouched");
  });

  test("you can rename your own team", async () => {
    await db.actAs(world.bob.userId);
    await db.q("update public.teams set name = $1 where id = $2", [
      "Bob City",
      world.bob.teamId,
    ]);

    const team = await db.one<{ name: string }>(
      "select name from public.teams where id = $1",
      [world.bob.teamId],
    );
    assert.equal(team.name, "Bob City");
  });

  test("a manager cannot give themselves FAAB", async () => {
    await db.actAs(world.bob.userId);

    await assert.rejects(
      () =>
        db.q("update public.teams set faab_remaining = 9999 where id = $1", [
          world.bob.teamId,
        ]),
      /Only the commissioner can change that field/,
    );

    const team = await db.one<{ faab_remaining: number }>(
      "select faab_remaining from public.teams where id = $1",
      [world.bob.teamId],
    );
    assert.equal(team.faab_remaining, 100);
  });

  test("you cannot set somebody else's lineup", async () => {
    await db.actAs(world.bob.userId);

    await assert.rejects(
      () =>
        db.q(
          `insert into public.lineup_entries
             (league_id, team_id, season, week, player_id, slot_key)
           values ($1, $2, $3, 1, 'RLS_WR', 'WR')`,
          [world.leagueA, world.alice.teamId, SEASON],
        ),
      /row-level security/,
    );
  });

  test("you can set your own lineup", async () => {
    await db.actAs(world.bob.userId);
    await db.q(
      `insert into public.lineup_entries
         (league_id, team_id, season, week, player_id, slot_key)
       values ($1, $2, $3, 1, 'RLS_WR', 'WR')`,
      [world.leagueA, world.bob.teamId, SEASON],
    );

    const entries = await db.q(
      "select id from public.lineup_entries where team_id = $1",
      [world.bob.teamId],
    );
    assert.equal(entries.length, 1);
  });
});

describe("roster tables are read-only to clients", () => {
  test("a manager cannot insert a roster row directly", async () => {
    await db.actAs(world.bob.userId);

    // roster_players has no write policy at all: every add goes through
    // add_free_agent, which checks availability and roster space.
    await assert.rejects(
      () =>
        db.q(
          `insert into public.roster_players (league_id, team_id, player_id)
           values ($1, $2, 'RLS_WR')`,
          [world.leagueA, world.bob.teamId],
        ),
      /row-level security/,
    );
  });

  test("but the RPC works, and enforces its own rules", async () => {
    await db.actAs(world.bob.userId);
    await db.q("select public.add_free_agent($1, $2)", [
      world.bob.teamId,
      "RLS_WR",
    ]);

    const roster = await db.q(
      "select id from public.roster_players where team_id = $1 and dropped_at is null",
      [world.bob.teamId],
    );
    assert.equal(roster.length, 1);

    // And Alice cannot take him off Bob's roster.
    await db.actAs(world.alice.userId);
    await assert.rejects(
      () =>
        db.q("select public.drop_player($1, $2)", [
          world.bob.teamId,
          "RLS_WR",
        ]),
      /not your team/,
    );
  });
});

describe("blind waiver bidding", () => {
  test("a pending bid is invisible to everyone but the bidder", async () => {
    await db.asSuperuser(async () => {
      await db.q(
        `insert into public.nfl_players (id, full_name, position, team_abbr)
         values ('RLS_RB', 'Waiver Target', 'RB', 'KC')
         on conflict (id) do nothing`,
      );
    });

    await db.actAs(world.bob.userId);
    await db.q(
      `insert into public.waiver_claims
         (league_id, team_id, add_player_id, bid_amount, season, week)
       values ($1, $2, 'RLS_RB', 47, $3, 1)`,
      [world.leagueA, world.bob.teamId, SEASON],
    );

    const mine = await db.q<{ bid_amount: number }>(
      "select bid_amount from public.waiver_claims where league_id = $1",
      [world.leagueA],
    );
    assert.equal(mine.length, 1, "Bob sees his own bid");
    assert.equal(mine[0].bid_amount, 47);

    // Alice is the commissioner of this very league and still cannot see
    // it -- otherwise blind bidding would not be blind.
    await db.actAs(world.alice.userId);
    const hers = await db.q(
      "select bid_amount from public.waiver_claims where league_id = $1",
      [world.leagueA],
    );
    assert.equal(hers.length, 0, "not even the commissioner can peek");
  });

  test("a processed claim becomes visible to the league", async () => {
    await db.asSuperuser(async () => {
      await db.q(
        "update public.waiver_claims set status = 'lost' where league_id = $1",
        [world.leagueA],
      );
    });

    await db.actAs(world.alice.userId);
    const visible = await db.q<{ bid_amount: number }>(
      "select bid_amount from public.waiver_claims where league_id = $1",
      [world.leagueA],
    );
    assert.equal(visible.length, 1, "once resolved, the league can see it");
    assert.equal(visible[0].bid_amount, 47);
  });

  test("you cannot bid on behalf of another team", async () => {
    await db.actAs(world.alice.userId);

    await assert.rejects(
      () =>
        db.q(
          `insert into public.waiver_claims
             (league_id, team_id, add_player_id, bid_amount, season, week)
           values ($1, $2, 'RLS_RB', 1, $3, 1)`,
          [world.leagueA, world.bob.teamId, SEASON],
        ),
      /row-level security/,
    );
  });
});

describe("commissioner-only settings", () => {
  test("a manager cannot change the league scoring", async () => {
    await db.actAs(world.bob.userId);

    await db.q(
      `update public.league_scoring_rules set points = 99
       where league_id = $1 and stat_key = 'receptions'`,
      [world.leagueA],
    );

    await db.actAs(world.alice.userId);
    const rule = await db.one<{ points: string }>(
      `select points from public.league_scoring_rules
       where league_id = $1 and stat_key = 'receptions'`,
      [world.leagueA],
    );
    assert.equal(Number(rule.points), 1, "the rule is unchanged");
  });

  test("the commissioner can", async () => {
    await db.actAs(world.alice.userId);
    await db.q(
      `update public.league_scoring_rules set points = 0.5
       where league_id = $1 and stat_key = 'receptions'`,
      [world.leagueA],
    );

    const rule = await db.one<{ points: string }>(
      `select points from public.league_scoring_rules
       where league_id = $1 and stat_key = 'receptions'`,
      [world.leagueA],
    );
    assert.equal(Number(rule.points), 0.5);
  });

  test("a manager cannot change league settings", async () => {
    await db.actAs(world.bob.userId);

    await db.q("update public.leagues set current_week = 17 where id = $1", [
      world.leagueA,
    ]);

    const leagueRow = await db.one<{ current_week: number }>(
      "select current_week from public.leagues where id = $1",
      [world.leagueA],
    );
    assert.equal(leagueRow.current_week, 1, "unchanged");
  });

  test("an outsider cannot generate another league's schedule", async () => {
    await db.actAs(world.mallory.userId);

    await assert.rejects(
      () => db.q("select public.generate_schedule($1)", [world.leagueA]),
      /Only the commissioner/,
    );
  });
});

describe("chat", () => {
  test("you cannot post as somebody else", async () => {
    await db.actAs(world.bob.userId);

    await assert.rejects(
      () =>
        db.q(
          `insert into public.league_messages (league_id, user_id, body)
           values ($1, $2, 'Alice said this')`,
          [world.leagueA, world.alice.userId],
        ),
      /row-level security/,
    );
  });

  test("you cannot fake a system message", async () => {
    await db.actAs(world.bob.userId);

    await assert.rejects(
      () =>
        db.q(
          `insert into public.league_messages
             (league_id, user_id, body, is_system)
           values ($1, $2, 'Waivers processed: you lost', true)`,
          [world.leagueA, world.bob.userId],
        ),
      /row-level security/,
    );
  });

  test("an outsider cannot read the league board", async () => {
    await db.actAs(world.bob.userId);
    await db.q(
      `insert into public.league_messages (league_id, user_id, body)
       values ($1, $2, 'my waiver bid is definitely not 47')`,
      [world.leagueA, world.bob.userId],
    );

    await db.actAs(world.mallory.userId);
    const messages = await db.q(
      "select id from public.league_messages where league_id = $1",
      [world.leagueA],
    );
    assert.equal(messages.length, 0);
  });
});

describe("league creation", () => {
  test("a signed-in user can create a league and read it straight back", async () => {
    // This is the exact call the app makes: insert with RETURNING, which
    // applies the SELECT policy to the new row before AFTER-row triggers
    // have fired. It used to fail outright.
    const carol = await db.createUser("carol@example.com", "Carol");
    await db.actAs(carol);

    const created = await db.one<{ id: string; join_code: string }>(
      `insert into public.leagues (name, season, commissioner_id)
       values ('Carol Cup', $1, $2) returning id, join_code`,
      [SEASON, carol],
    );

    // The triggers must have run: membership, roster slots, scoring.
    const membership = await db.q<{ role: string }>(
      "select role from public.league_members where league_id = $1",
      [created.id],
    );
    assert.deepEqual(membership.map((m) => m.role), ["commissioner"]);

    const slots = await db.q(
      "select id from public.roster_slots where league_id = $1",
      [created.id],
    );
    assert.equal(slots.length, 9, "the default roster is seeded");

    const rules = await db.q(
      "select id from public.league_scoring_rules where league_id = $1",
      [created.id],
    );
    assert.ok(rules.length > 130, "the scoring catalog is seeded");

    // And joining it works end to end.
    await db.q("select public.join_league($1, $2)", [
      created.join_code,
      "Carol FC",
    ]);
    const team = await db.q(
      "select id from public.teams where league_id = $1",
      [created.id],
    );
    assert.equal(team.length, 1);
  });

  test("you cannot create a league in somebody else's name", async () => {
    await db.actAs(world.bob.userId);

    await assert.rejects(
      () =>
        db.q(
          `insert into public.leagues (name, season, commissioner_id)
           values ('Not Mine', $1, $2)`,
          [SEASON, world.alice.userId],
        ),
      /row-level security/,
    );
  });
});

describe("trades", () => {
  test("you can only propose a trade from your own team", async () => {
    await db.actAs(world.bob.userId);

    // Proposing from Alice's team, as Bob.
    await assert.rejects(
      () =>
        db.q(
          `insert into public.trades
             (league_id, proposing_team_id, receiving_team_id, season, week)
           values ($1, $2, $3, $4, 1)`,
          [world.leagueA, world.alice.teamId, world.bob.teamId, SEASON],
        ),
      /row-level security/,
    );
  });

  test("a proposal from your own team is allowed, and both sides see it", async () => {
    await db.actAs(world.bob.userId);

    const trade = await db.one<{ id: string }>(
      `insert into public.trades
         (league_id, proposing_team_id, receiving_team_id, season, week)
       values ($1, $2, $3, $4, 1) returning id`,
      [world.leagueA, world.bob.teamId, world.alice.teamId, SEASON],
    );

    await db.actAs(world.alice.userId);
    const seen = await db.q(
      "select id from public.trades where id = $1",
      [trade.id],
    );
    assert.equal(seen.length, 1, "the receiving manager sees the offer");

    // But an outsider does not.
    await db.actAs(world.mallory.userId);
    const hidden = await db.q(
      "select id from public.trades where id = $1",
      [trade.id],
    );
    assert.equal(hidden.length, 0);
  });

  test("a manager cannot propose a trade that is already accepted", async () => {
    await db.actAs(world.bob.userId);

    // Otherwise you could skip the other manager agreeing to it.
    await assert.rejects(
      () =>
        db.q(
          `insert into public.trades
             (league_id, proposing_team_id, receiving_team_id, season, week, status)
           values ($1, $2, $3, $4, 1, 'accepted')`,
          [world.leagueA, world.bob.teamId, world.alice.teamId, SEASON],
        ),
      /row-level security/,
    );
  });

  test("an outsider cannot execute a trade they are not part of", async () => {
    await db.actAs(world.bob.userId);
    const trade = await db.one<{ id: string }>(
      `insert into public.trades
         (league_id, proposing_team_id, receiving_team_id, season, week)
       values ($1, $2, $3, $4, 1) returning id`,
      [world.leagueA, world.bob.teamId, world.alice.teamId, SEASON],
    );

    // Alice accepts, as she is entitled to.
    await db.actAs(world.alice.userId);
    await db.q("update public.trades set status = 'accepted' where id = $1", [
      trade.id,
    ]);

    // Mallory, in another league entirely, must not be able to push it
    // through even though execute_trade is SECURITY DEFINER.
    await db.actAs(world.mallory.userId);
    await assert.rejects(
      () => db.q("select public.execute_trade($1)", [trade.id]),
      /not your trade/,
    );

    // The parties themselves can.
    await db.actAs(world.alice.userId);
    await db.q("select public.execute_trade($1)", [trade.id]);

    const done = await db.one<{ status: string }>(
      "select status from public.trades where id = $1",
      [trade.id],
    );
    assert.equal(done.status, "completed");
  });
});

describe("private draft queues", () => {
  test("your draft queue is yours alone", async () => {
    await db.actAs(world.bob.userId);
    await db.q(
      "insert into public.draft_queue (team_id, player_id, rank) values ($1, 'RLS_WR', 1)",
      [world.bob.teamId],
    );

    const mine = await db.q(
      "select id from public.draft_queue where team_id = $1",
      [world.bob.teamId],
    );
    assert.equal(mine.length, 1);

    await db.actAs(world.alice.userId);
    const hers = await db.q(
      "select id from public.draft_queue where team_id = $1",
      [world.bob.teamId],
    );
    assert.equal(hers.length, 0, "a rival cannot read your rankings");
  });
});
