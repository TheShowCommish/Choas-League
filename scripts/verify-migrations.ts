/**
 * Applies every migration to a throwaway in-memory Postgres to check it
 * parses and runs, before we point it at the real project.
 *
 *   npm run db:verify
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { MIGRATIONS_DIR, migrationFiles } from "./lib/test-db.ts";

// Applied one at a time (rather than via createTestDb) so a failure can
// name the file it came from.
const db = await PGlite.create({ extensions: { pgcrypto } });
await db.exec("create extension if not exists pgcrypto;");
await db.exec(`
  create schema if not exists auth;
  create table if not exists auth.users (
    id uuid primary key, email text,
    raw_user_meta_data jsonb not null default '{}'::jsonb);
  create or replace function auth.uid() returns uuid language sql stable
    as $fn$ select nullif(current_setting('test.uid', true), '')::uuid $fn$;
  create or replace function auth.jwt() returns jsonb language sql stable
    as $fn$ select '{}'::jsonb $fn$;
  do $do$ begin
    if not exists (select 1 from pg_roles where rolname = 'authenticated')
      then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'anon')
      then create role anon; end if;
  end $do$;
`);

const files = migrationFiles();
let failed = 0;

for (const file of files) {
  try {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    console.log(`  ok    ${file}`);
  } catch (err) {
    failed++;
    const e = err as Error & { hint?: string; query?: string };
    console.error(`  FAIL  ${file}`);
    console.error(`        ${e.message}`);
    if (e.hint) console.error(`        hint: ${e.hint}`);
    if (e.query) console.error(`        in:   ${e.query.slice(0, 300)}`);
  }
}

if (failed === 0) {
  const stats = await db.query<{ n: number }>(
    "select count(*)::int as n from public.stat_definitions",
  );
  const tables = await db.query<{ n: number }>(
    `select count(*)::int as n from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );
  console.log(
    `
All ${files.length} migrations applied. ` +
      `${tables.rows[0].n} tables, ${stats.rows[0].n} stat definitions.`,
  );
}

await db.close();
process.exit(failed === 0 ? 0 : 1);
