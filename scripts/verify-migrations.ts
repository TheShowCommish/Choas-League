/**
 * Applies every migration to a throwaway in-memory Postgres (PGlite) to
 * check it parses and runs, before we point it at the real project.
 *
 *   npm run db:verify
 *
 * PGlite has no Supabase auth schema, so we stub the few things the
 * migrations touch: auth.users, auth.uid(), auth.jwt(), and the
 * `authenticated` / `anon` roles. Everything else runs for real, which
 * catches typos, bad column references and broken PL/pgSQL.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "supabase", "migrations");

const STUBS = `
create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text
);

create or replace function auth.uid() returns uuid
  language sql stable as $fn$ select current_setting('test.uid', true)::uuid $fn$;

create or replace function auth.jwt() returns jsonb
  language sql stable as $fn$
    select coalesce(current_setting('test.jwt', true)::jsonb, '{}'::jsonb)
  $fn$;

do $do$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon;
  end if;
end $do$;
`;

const db = await PGlite.create({ extensions: { pgcrypto } });

await db.exec("create extension if not exists pgcrypto;");
await db.exec(STUBS);

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

let failed = 0;
for (const file of files) {
  const sql = readFileSync(join(migrationsDir, file), "utf8");
  try {
    await db.exec(sql);
    console.log(`  ok    ${file}`);
  } catch (err) {
    failed++;
    const e = err as Error & { hint?: string; query?: string };
    console.error(`  FAIL  ${file}`);
    console.error(`        ${e.message}`);
    if (e.hint) console.error(`        hint: ${e.hint}`);
    if (e.query) console.error(`        in: ${e.query.slice(0, 400)}`);
  }
}

if (failed === 0) {
  const { rows } = await db.query<{ n: number }>(
    "select count(*)::int as n from public.stat_definitions",
  );
  const { rows: tables } = await db.query<{ n: number }>(
    "select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
  );
  console.log(
    `\nAll ${files.length} migrations applied. ` +
      `${tables[0].n} tables, ${rows[0].n} stat definitions.`,
  );
}

await db.close();
process.exit(failed === 0 ? 0 : 1);
