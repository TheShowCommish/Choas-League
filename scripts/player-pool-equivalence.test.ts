/**
 * T-062 equivalence guard: marking the player-pool CTEs `materialized`
 * (0043) must be a pure execution-strategy change. The rows, their
 * values, their order, the total_count and the pagination boundaries must
 * be byte-for-byte identical to the inlined (pre-0043) behaviour.
 *
 *   npm test
 *
 * How it works: the shipped function in the test DB is the materialized
 * one (0043). We build an INLINED shadow from the very same 0043 file,
 * stripping only ` as materialized (` -> ` as (`, and run both side by
 * side over a rich, varied pool across every filter / sort / direction /
 * page combination. Any divergence fails.
 *
 * This file only reads the migration and seeds a throwaway PGlite; it
 * changes no app code.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestDb, type TestDb, MIGRATIONS_DIR } from "./lib/test-db.ts";
import { SEASON, buildLeague } from "./lib/fixtures.ts";

let db: TestDb;
let leagueId: string;
let teamIds: string[];

const CURRENT_WEEK = 10;

/** Build the inlined (non-materialized) twin from the real 0043 file. */
function buildInlinedShadowSql(): string {
  const src = readFileSync(
    join(MIGRATIONS_DIR, "0043_player_pool_materialize_ctes.sql"),
    "utf8",
  );
  const start = src.indexOf(
    "create or replace function public.league_player_pool(",
  );
  const grantStart = src.indexOf(
    "grant execute on function public.league_player_pool(",
    start,
  );
  const grantEnd =
    src.indexOf("to authenticated;", grantStart) + "to authenticated;".length;
  let fn = src.slice(start, grantEnd);
  // The entire difference under test: remove the materialization fences.
  const before = (fn.match(/ as materialized \(/g) || []).length;
  assert.equal(before, 7, "expected exactly 7 materialized CTEs in 0043");
  fn = fn.replace(/ as materialized \(/g, " as (");
  assert.equal(
    (fn.match(/ as materialized \(/g) || []).length,
    0,
    "all materialized fences removed",
  );
  // Rename the function (and its grant) to a shadow so both coexist.
  fn = fn.replaceAll(
    "function public.league_player_pool(",
    "function public.league_player_pool_inlined(",
  );
  return fn;
}

before(async () => {
  db = await createTestDb();
  const f = await buildLeague(db, "pool-eq");
  leagueId = f.leagueId;
  teamIds = f.teamIds;

  // The inlined twin, built from the shipped 0043 text.
  await db.exec(buildInlinedShadowSql());

  const teams = (
    await db.q<{ abbr: string }>(
      "select abbr from public.nfl_teams order by abbr",
    )
  ).map((r) => r.abbr);
  assert.ok(teams.length >= 8, "need a handful of NFL teams seeded");

  const ruleKeys = (
    await db.q<{ stat_key: string }>(
      "select distinct stat_key from public.league_scoring_rules where league_id = $1",
      [leagueId],
    )
  ).map((r) => r.stat_key);
  assert.ok(ruleKeys.length > 0, "league has scoring rules");
  const projStats: Record<string, number> = {};
  for (let k = 0; k < Math.min(12, ruleKeys.length); k++) {
    projStats[ruleKeys[k]] = (k + 1) * 1.25;
  }

  // ---- Players: varied positions, teams, adp, injuries, headshots ----
  // Mix of fantasy and non-fantasy ids (DST_/OL_/HC_ and a bare defender)
  // to confirm is_fantasy_player filtering is identical.
  const positions = ["QB", "RB", "WR", "TE", "K", "P", "FB"];
  const rows: string[] = [];
  for (let i = 0; i < 48; i++) {
    const pos = positions[i % positions.length];
    // Some players share a team; a few have NULL team_abbr (no bye / next).
    const team = i % 11 === 0 ? "NULL" : `'${teams[i % teams.length]}'`;
    // adp: many set, some null, deliberate ties in adp_rank and adp.
    const adp = i % 7 === 0 ? "NULL" : (10 + (i % 5) * 0.5).toFixed(2);
    const adpRank = i % 7 === 0 ? "NULL" : String(10 + (i % 5));
    const injury =
      i % 6 === 0 ? "'Questionable'" : i % 6 === 3 ? "'Out'" : "NULL";
    const bodyPart = i % 6 === 0 ? "'Hamstring'" : "NULL";
    const head = i % 4 === 0 ? `'https://img/${i}.png'` : "NULL";
    // Names chosen so text search ('son', 'xyz') has hits and misses.
    const name = i % 3 === 0 ? `Johnson ${i}` : `Player ${i}`;
    rows.push(
      `('EQ${i}', '${name}', '${pos}', ${team}, 'ACT', ${head}, ${adp}, ${adpRank}, ${injury}, ${bodyPart})`,
    );
  }
  // A few non-fantasy entities that must be excluded identically.
  rows.push(`('DST_1', 'Team D/ST', 'DEF', '${teams[0]}', 'ACT', NULL, NULL, NULL, NULL, NULL)`);
  rows.push(`('OL_1', 'Some Lineman', 'OL', '${teams[1]}', 'ACT', NULL, NULL, NULL, NULL, NULL)`);
  rows.push(`('CBX', 'A Cornerback', 'CB', '${teams[2]}', 'ACT', NULL, NULL, NULL, NULL, NULL)`);

  await db.q(
    `insert into public.nfl_players
       (id, full_name, position, team_abbr, status, headshot_url, adp, adp_rank, injury_status, injury_body_part)
     values ${rows.join(",")}
     on conflict (id) do nothing`,
  );

  // ---- Projections for a subset (some players have none => null proj) --
  const projValues: string[] = [];
  for (let i = 0; i < 48; i += 1) {
    if (i % 5 === 4) continue; // ~1/5 have no projection row
    projValues.push(`('EQ${i}', ${SEASON}, '${JSON.stringify(projStats)}'::jsonb)`);
  }
  await db.q(
    `insert into public.player_season_projections (player_id, season, stats)
     values ${projValues.join(",")}
     on conflict (player_id, season) do nothing`,
  );

  // ---- Week scores: varied game counts, deliberate ties, some zero ----
  // Players EQ0..EQ39 get scores; EQ40..EQ47 get none (games=0, totals 0).
  // Scores engineered so several players tie on total_points (exercises
  // the stable tiebreak) and some share last-week points.
  const scoreValues: string[] = [];
  for (let i = 0; i < 40; i++) {
    const nWeeks = (i % 4) + 1; // 1..4 games played, varied
    for (let w = 1; w <= nWeeks; w++) {
      // Make total_points collide across groups of players.
      const pts = ((i % 6) + w).toFixed(2);
      scoreValues.push(`('${leagueId}', 'EQ${i}', ${SEASON}, ${w}, ${pts})`);
    }
    // Give some players an explicit score in the "last week" (week 9).
    if (i % 3 === 0) {
      scoreValues.push(
        `('${leagueId}', 'EQ${i}', ${SEASON}, ${CURRENT_WEEK - 1}, ${(i % 5).toFixed(2)})`,
      );
    }
  }
  await db.q(
    `insert into public.player_week_scores (league_id, player_id, season, week, points)
     values ${scoreValues.join(",")}
     on conflict (league_id, player_id, season, week) do nothing`,
  );

  // ---- Ownership: roster some, drop one (must be excluded from owned) --
  await db.q(
    `insert into public.roster_players (league_id, team_id, player_id, acquired_via)
     values
       ($1, $2, 'EQ0', 'draft'),
       ($1, $2, 'EQ1', 'draft'),
       ($1, $3, 'EQ2', 'waiver'),
       ($1, $3, 'EQ7', 'trade')`,
    [leagueId, teamIds[0], teamIds[1]],
  );
  // A dropped roster row: must NOT appear as owned in either function.
  await db.q(
    `insert into public.roster_players (league_id, team_id, player_id, acquired_via, dropped_at)
     values ($1, $2, 'EQ3', 'free_agent', now() - interval '1 day')`,
    [leagueId, teamIds[0]],
  );

  // ---- Waivers: one active hold, one already-cleared (excluded) -------
  await db.q(
    `insert into public.waiver_holds (league_id, player_id, clears_at) values
       ($1, 'EQ5', now() + interval '2 days'),
       ($1, 'EQ8', now() + interval '1 day'),
       ($1, 'EQ9', now() - interval '1 hour')`, // cleared -> not on_waivers
    [leagueId],
  );

  // ---- Schedule: byes + next games; leave some teams without a next ----
  for (let w = 1; w <= 17; w++) {
    const games: string[] = [];
    // Rotate pairings so each week a different pair sits out -> real byes.
    const skip = w % (teams.length / 2 | 0);
    for (let ti = 0, pair = 0; ti + 1 < teams.length; ti += 2, pair++) {
      if (pair === skip) continue; // this pair has a bye this week
      const id = `${SEASON}_${String(w).padStart(2, "0")}_${teams[ti]}_${teams[ti + 1]}`;
      games.push(
        `('${id}', ${SEASON}, ${w}, 'REG', '${teams[ti]}', '${teams[ti + 1]}', now() + interval '${w} days', 'scheduled')`,
      );
    }
    if (games.length) {
      await db.q(
        `insert into public.nfl_games
           (id, season, week, season_type, home_team, away_team, kickoff_at, status)
         values ${games.join(",")}
         on conflict (id) do nothing`,
      );
    }
  }

  await db.exec(
    `update public.leagues set season = ${SEASON}, current_week = ${CURRENT_WEEK}
     where id = '${leagueId}'`,
  );
  await db.exec("analyze");
});

after(async () => {
  await db.close();
});

type Row = Record<string, unknown>;

async function callPool(
  fn: "league_player_pool" | "league_player_pool_inlined",
  opts: {
    search?: string | null;
    position?: string | null;
    availability?: string;
    sort?: string;
    limit?: number;
    offset?: number;
    team?: string | null;
    dir?: string;
  } = {},
): Promise<Row[]> {
  const {
    search = null,
    position = null,
    availability = "all",
    sort = "points",
    limit = 500,
    offset = 0,
    team = null,
    dir = "desc",
  } = opts;
  return db.q<Row>(
    `select * from public.${fn}($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [leagueId, search, position, availability, sort, limit, offset, team, dir],
  );
}

/** Deep, stringified compare so pg's numeric-as-string etc. line up. */
function rowsEqual(a: Row[], b: Row[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function describeCombo(o: object): string {
  return JSON.stringify(o);
}

describe("league_player_pool: materialized == inlined, full output (T-062)", () => {
  const sorts = [
    "points",
    "projection",
    "last",
    "average",
    "games",
    "name",
    "position",
    "team",
    "adp",
    "kickoff",
    "opponent",
    "owner",
  ];
  const dirs = ["asc", "desc"];

  test("every sort x direction returns identical rows and order", async () => {
    for (const sort of sorts) {
      for (const dir of dirs) {
        const combo = { sort, dir };
        const mat = await callPool("league_player_pool", combo);
        const inl = await callPool("league_player_pool_inlined", combo);
        assert.ok(mat.length > 0, `pool non-empty for ${describeCombo(combo)}`);
        assert.ok(
          rowsEqual(mat, inl),
          `rows/order diverged for ${describeCombo(combo)}`,
        );
      }
    }
  });

  test("every availability mode returns identical rows", async () => {
    for (const availability of ["all", "available", "rostered", "waivers"]) {
      const combo = { availability, sort: "points", dir: "desc" };
      const mat = await callPool("league_player_pool", combo);
      const inl = await callPool("league_player_pool_inlined", combo);
      assert.ok(
        rowsEqual(mat, inl),
        `availability=${availability} diverged`,
      );
    }
    // The three waiver rows: EQ5 + EQ8 active, EQ9 cleared -> 2 on waivers.
    const waivers = await callPool("league_player_pool", {
      availability: "waivers",
    });
    const ids = waivers.map((r) => r.player_id).sort();
    assert.deepEqual(ids, ["EQ5", "EQ8"], "cleared hold must not count");
    assert.ok(
      waivers.every((r) => r.on_waivers === true),
      "waiver rows report on_waivers",
    );
  });

  test("rostered excludes the dropped player (owned CTE)", async () => {
    const rostered = await callPool("league_player_pool", {
      availability: "rostered",
    });
    const ids = new Set(rostered.map((r) => r.player_id));
    assert.ok(!ids.has("EQ3"), "dropped player must not be rostered");
    assert.ok(ids.has("EQ0") && ids.has("EQ2"), "active roster present");
  });

  test("every position filter (+ FLEX + empty) is identical", async () => {
    for (const position of [
      null,
      "",
      "QB",
      "RB",
      "WR",
      "TE",
      "K",
      "P",
      "FB",
      "FLEX",
      "DEF", // no fantasy players -> empty, must match
    ]) {
      const combo = { position, sort: "name", dir: "asc" };
      const mat = await callPool("league_player_pool", combo);
      const inl = await callPool("league_player_pool_inlined", combo);
      assert.ok(
        rowsEqual(mat, inl),
        `position=${position} diverged`,
      );
    }
  });

  test("is_fantasy_player membership is identical (unit ids in, bare defender out)", async () => {
    const mat = await callPool("league_player_pool", { limit: 500 });
    const inl = await callPool("league_player_pool_inlined", { limit: 500 });
    assert.ok(rowsEqual(mat, inl), "full unfiltered pool must match");
    const ids = new Set(mat.map((r) => r.player_id));
    // DST_/OL_ ids are the team unit pseudo-players and ARE fantasy
    // players per is_fantasy_player; a bare individual defender is not.
    assert.ok(ids.has("DST_1"), "team D/ST unit is a fantasy player");
    assert.ok(ids.has("OL_1"), "OL unit id is a fantasy player");
    assert.ok(!ids.has("CBX"), "individual defender must be filtered out");
  });

  test("team filter (incl. empty + unused team) is identical", async () => {
    const teams = (
      await db.q<{ abbr: string }>(
        "select abbr from public.nfl_teams order by abbr",
      )
    ).map((r) => r.abbr);
    for (const team of [null, "", teams[0], teams[3], "ZZZ"]) {
      const combo = { team, sort: "points", dir: "desc" };
      const mat = await callPool("league_player_pool", combo);
      const inl = await callPool("league_player_pool_inlined", combo);
      assert.ok(rowsEqual(mat, inl), `team=${team} diverged`);
    }
  });

  test("text search (hit, miss, empty) is identical", async () => {
    for (const search of [null, "", "son", "Player 1", "zzzznope"]) {
      const combo = { search, sort: "name", dir: "asc" };
      const mat = await callPool("league_player_pool", combo);
      const inl = await callPool("league_player_pool_inlined", combo);
      assert.ok(rowsEqual(mat, inl), `search=${search} diverged`);
    }
  });
});

describe("league_player_pool: pagination equivalence (T-062)", () => {
  // Page through with a small limit and confirm (a) the concatenation of
  // pages equals a single full call, (b) total_count is stable, and (c)
  // the materialized and inlined versions paginate identically -- no
  // duplicate or missing player across page boundaries.
  const PAGE = 7;

  async function paged(
    fn: "league_player_pool" | "league_player_pool_inlined",
    sort: string,
    dir: string,
  ): Promise<Row[]> {
    const out: Row[] = [];
    let offset = 0;
    // Generous ceiling; pool is < 60 fantasy players.
    for (let guard = 0; guard < 100; guard++) {
      const page = await callPool(fn, { sort, dir, limit: PAGE, offset });
      out.push(...page);
      if (page.length < PAGE) break;
      offset += PAGE;
    }
    return out;
  }

  for (const [sort, dir] of [
    ["points", "desc"],
    ["name", "asc"],
    ["adp", "desc"],
    ["projection", "desc"],
    ["average", "asc"],
  ] as const) {
    test(`paged ${sort}/${dir} matches a single full call and the inlined twin`, async () => {
      const full = await callPool("league_player_pool", {
        sort,
        dir,
        limit: 500,
      });
      const pagedMat = await paged("league_player_pool", sort, dir);
      const pagedInl = await paged("league_player_pool_inlined", sort, dir);

      // total_count is constant across every page.
      const counts = new Set(pagedMat.map((r) => String(r.total_count)));
      assert.equal(counts.size, 1, `total_count stable for ${sort}/${dir}`);
      assert.equal(
        String([...counts][0]),
        String(full.length),
        "total_count equals the real row count",
      );

      // No duplicates, nothing missing, order preserved.
      assert.ok(
        rowsEqual(pagedMat, full),
        `paged order != full order for ${sort}/${dir}`,
      );
      assert.ok(
        rowsEqual(pagedMat, pagedInl),
        `paged materialized != paged inlined for ${sort}/${dir}`,
      );

      const ids = pagedMat.map((r) => r.player_id);
      assert.equal(
        new Set(ids).size,
        ids.length,
        `no player repeats across pages for ${sort}/${dir}`,
      );
    });
  }
});
