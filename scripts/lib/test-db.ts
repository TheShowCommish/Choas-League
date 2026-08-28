/**
 * Spins up a throwaway Postgres (PGlite) with every migration applied,
 * for the migration verifier and the logic tests to share.
 *
 * PGlite has no Supabase auth schema, so auth.users / auth.uid() /
 * auth.jwt() are stubbed. `auth.uid()` reads a session setting, which
 * lets a test act as a given user via `db.actAs(userId)`.
 *
 * By default PGlite runs as superuser, which bypasses RLS. Pass
 * `{ enforceRls: true }` to createTestDb to switch the connection to the
 * `authenticated` role and FORCE row level security on every table, so
 * the policies themselves can be tested.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, "..", "..", "supabase", "migrations");

const STUBS = `
create schema if not exists auth;

create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

create or replace function auth.uid() returns uuid
  language sql stable as $fn$
    select nullif(current_setting('test.uid', true), '')::uuid
  $fn$;

create or replace function auth.jwt() returns jsonb
  language sql stable as $fn$
    select coalesce(nullif(current_setting('test.jwt', true), '')::jsonb, '{}'::jsonb)
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

export interface TestDb {
  raw: PGlite;
  /** True when RLS is being enforced rather than bypassed. */
  enforceRls: boolean;
  exec(sql: string): Promise<unknown>;
  /** Run a query and return its rows. */
  q<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run a query and return the single first row. */
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T>;
  /** Every subsequent call runs as this user, as far as auth.uid() sees. */
  actAs(userId: string | null): Promise<void>;
  /** Create an auth user + profile and return the id. */
  createUser(email: string, displayName?: string): Promise<string>;
  /** Run something with RLS bypassed, for test setup. */
  asSuperuser<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

export async function createTestDb(
  options: { enforceRls?: boolean } = {},
): Promise<TestDb> {
  const enforceRls = options.enforceRls ?? false;

  const pg = await PGlite.create({ extensions: { pgcrypto } });
  await pg.exec("create extension if not exists pgcrypto;");
  await pg.exec(STUBS);

  for (const file of migrationFiles()) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }

  if (enforceRls) {
    // Supabase grants these to `authenticated` as a matter of course;
    // a bare Postgres does not, and without them RLS never gets a look
    // in because the role cannot reach the table at all.
    await pg.exec(`
      grant usage on schema public to authenticated;
      grant all on all tables in schema public to authenticated;
      grant all on all sequences in schema public to authenticated;
      grant usage on schema auth to authenticated;
      grant select on auth.users to authenticated;
    `);

    // A table owner is exempt from its own policies unless forced, and
    // in PGlite the owner is who we would otherwise be running as.
    const { rows } = await pg.query<{ tablename: string }>(
      `select tablename from pg_tables
       where schemaname = 'public' and rowsecurity = true`,
    );
    for (const { tablename } of rows) {
      await pg.exec(
        `alter table public.${tablename} force row level security;`,
      );
    }

    await pg.exec("set role authenticated;");
  }

  const db: TestDb = {
    raw: pg,
    enforceRls,
    exec: (sql) => pg.exec(sql),
    async q<T>(sql: string, params?: unknown[]) {
      const res = await pg.query<T>(sql, params as never[]);
      return res.rows;
    },
    async one<T>(sql: string, params?: unknown[]) {
      const res = await pg.query<T>(sql, params as never[]);
      if (res.rows.length === 0) {
        throw new Error(`Expected a row from: ${sql}`);
      }
      return res.rows[0];
    },
    async actAs(userId) {
      await pg.query("select set_config('test.uid', $1, false)", [userId ?? ""]);
      const email = userId
        ? (
            await pg.query<{ email: string }>(
              "select email from auth.users where id = $1",
              [userId],
            )
          ).rows[0]?.email
        : null;
      await pg.query("select set_config('test.jwt', $1, false)", [
        email ? JSON.stringify({ email }) : "",
      ]);
    },
    async createUser(email, displayName) {
      // Creating an auth user writes to profiles through a trigger, and
      // under enforced RLS the authenticated role cannot do either.
      return db.asSuperuser(async () => {
        const { rows } = await pg.query<{ id: string }>(
          "insert into auth.users (email) values ($1) returning id",
          [email],
        );
        const id = rows[0].id;
        await pg.query(
          `insert into public.profiles (id, email, display_name)
           values ($1, $2, $3)
           on conflict (id) do update set display_name = excluded.display_name`,
          [id, email, displayName ?? email.split("@")[0]],
        );
        return id;
      });
    },
    async asSuperuser<T>(fn: () => Promise<T>): Promise<T> {
      if (!enforceRls) return fn();
      await pg.exec("reset role;");
      try {
        return await fn();
      } finally {
        await pg.exec("set role authenticated;");
      }
    },
    close: () => pg.close(),
  };

  return db;
}
