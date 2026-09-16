/**
 * The stat catalog seed has to survive being re-run out of order.
 *
 * `npm run db:push -- --redo 0010` re-applies the generated catalog and
 * then applies whatever else is outstanding, in filename order. On a
 * database that is behind, that means 0010 lands *before* the pending
 * migrations numbered above it -- so 0010 cannot depend on anything
 * they do.
 *
 * That is not hypothetical. Adding the team O-line stats put a new
 * applies_to value in 0010 while the constraint permitting it was
 * widened in 0034, and the redo failed on a real database with
 * "violates check constraint stat_definitions_applies_to_check". The
 * constraint now lives in the generated file itself, and these are the
 * tests that say so.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  applyMigration,
  createBareDb,
  migrationFiles,
} from "./lib/test-db.ts";
import { STAT_APPLIES_TO, STAT_CATALOG } from "../src/lib/stats/catalog.ts";

const CATALOG_SEED = "0010_seed_stat_definitions.sql";

/** The migration that introduced the O-line stats' applies_to value. */
const OLINE = "0034_draft_board_and_player_pool.sql";

describe("re-running the catalog seed out of order", () => {
  test("--redo 0010 on a database that is behind", async () => {
    // The exact shape of the failure: a project sitting at 0033, told to
    // redo the catalog. push-migrations runs the redone file and the
    // pending ones together, in filename order, so 0010 goes first and
    // 0034 -- which is where the new stats' constraint used to live --
    // goes after.
    const pg = await createBareDb();
    try {
      for (const file of migrationFiles().filter((f) => f < OLINE)) {
        await applyMigration(pg, file);
      }

      await applyMigration(pg, CATALOG_SEED);
      await applyMigration(pg, OLINE);

      const { rows } = await pg.query<{ n: number }>(
        `select count(*)::int as n from public.stat_definitions
         where applies_to = 'team_offense'`,
      );
      assert.ok(
        rows[0].n > 0,
        "the O-line stats seeded before the migration that used to permit them",
      );
    } finally {
      await pg.close();
    }
  });

  test("--redo 0010 on a database that is up to date", async () => {
    const pg = await createBareDb();
    try {
      for (const file of migrationFiles()) await applyMigration(pg, file);
      await applyMigration(pg, CATALOG_SEED);

      const { rows } = await pg.query<{ n: number }>(
        "select count(*)::int as n from public.stat_definitions",
      );
      assert.equal(
        rows[0].n,
        STAT_CATALOG.length,
        "every catalog stat is seeded, and only those",
      );
    } finally {
      await pg.close();
    }
  });

  test("the seed's constraint admits every applies_to the catalog uses", async () => {
    const used = [...new Set(STAT_CATALOG.map((s) => s.appliesTo))];
    for (const value of used) {
      assert.ok(
        STAT_APPLIES_TO.includes(value),
        `${value} is in STAT_APPLIES_TO, which is what the seed emits`,
      );
    }

    const pg = await createBareDb();
    try {
      for (const file of migrationFiles()) await applyMigration(pg, file);

      // Every declared value has to be insertable, or adding a kind of
      // stat breaks the redo again.
      for (const value of STAT_APPLIES_TO) {
        await pg.query(
          `insert into public.stat_definitions
             (key, label, category, applies_to, value_type)
           values ($1, 'Probe', 'Probe', $2, 'count')`,
          [`probe_${value}`, value],
        );
      }

      const { rows } = await pg.query<{ n: number }>(
        `select count(*)::int as n from public.stat_definitions
         where category = 'Probe'`,
      );
      assert.equal(rows[0].n, STAT_APPLIES_TO.length);
    } finally {
      await pg.close();
    }
  });

  test("a stat dropped from the catalog is not left behind", async () => {
    const pg = await createBareDb();
    try {
      for (const file of migrationFiles()) await applyMigration(pg, file);

      await pg.query(
        `insert into public.stat_definitions
           (key, label, category, applies_to, value_type)
         values ('gone_from_catalog', 'Gone', 'Probe', 'player', 'count')`,
      );

      await applyMigration(pg, CATALOG_SEED);

      const { rows } = await pg.query<{ n: number }>(
        `select count(*)::int as n from public.stat_definitions
         where key = 'gone_from_catalog'`,
      );
      assert.equal(rows[0].n, 0, "the seed clears what the catalog dropped");
    } finally {
      await pg.close();
    }
  });
});
