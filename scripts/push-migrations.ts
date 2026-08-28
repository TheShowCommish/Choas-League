/**
 * Applies pending migrations to the real Supabase project.
 *
 *   npm run db:push -- --dry-run          # what would run, and nothing else
 *   npm run db:push -- --baseline 0023    # mark 0001-0023 as already applied
 *   npm run db:push -- --redo 0010        # re-run one, then the rest
 *   npm run db:push                       # apply everything outstanding
 *
 * --redo exists for 0010, which is generated from the stat catalog and
 * is rewritten whenever a stat is added. It is an upsert followed by a
 * delete of anything no longer in the catalog, so running it again is
 * how the catalog gets updated -- history says it is applied, and that
 * is true of the old version of the file rather than the new one.
 *
 * The counterpart to db:verify, which applies the same files to a
 * throwaway in-memory Postgres to check they parse. This one talks to
 * the project, so it is the only script here that can break anything.
 *
 * Why not `supabase db push`: the CLI keeps its own history table, and
 * this project's first twenty-three migrations were applied by hand
 * before any history existed. The CLI would see them as pending and try
 * to run them again. Hence --baseline, which records a range as applied
 * without executing it.
 *
 * Needs a direct Postgres connection, which the anon and service-role
 * keys cannot give you -- those go through PostgREST, which will not run
 * DDL. Add to .env.local, from Dashboard > Project Settings > Database >
 * Connection string > URI:
 *
 *   SUPABASE_DB_URL=postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres
 *
 * Use the direct connection or the session pooler. The transaction
 * pooler on port 6543 cannot hold the advisory lock this takes.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));

// Deliberately not imported from lib/test-db.ts: that module pulls in
// PGlite, and loading a wasm Postgres to deploy to a real one is silly.
const MIGRATIONS_DIR = join(here, "..", "supabase", "migrations");

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

loadEnv(join(here, "..", ".env.local"));

function loadEnv(path: string) {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!(key in process.env)) process.env[key] = trimmed.slice(eq + 1).trim();
  }
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const baselineAt = readFlag("--baseline");
const redo = readAllFlags("--redo");

/** Every occurrence of a repeatable flag. */
function readAllFlags(name: string): string[] {
  const out: string[] = [];
  args.forEach((arg, index) => {
    if (arg !== name) return;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      console.error(`${name} needs a value, e.g. ${name} 0010`);
      process.exit(1);
    }
    out.push(value);
  });
  return out;
}

function readFlag(name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    console.error(`${name} needs a value, e.g. ${name} 0023`);
    process.exit(1);
  }
  return value;
}

/** "0024_auto_recompute_season.sql" -> "0024" */
function versionOf(file: string): string {
  return file.split("_")[0];
}

const connectionString = process.env.SUPABASE_DB_URL;
if (!connectionString) {
  console.error(
    "SUPABASE_DB_URL is not set.\n\n" +
      "  Dashboard > Project Settings > Database > Connection string > URI\n" +
      "  Add it to .env.local. It contains your database password, so keep\n" +
      "  it out of commits and out of chat.\n",
  );
  process.exit(1);
}

const client = new pg.Client({
  connectionString,
  // Supabase terminates TLS at the pooler with a certificate chain node
  // does not ship a root for.
  ssl: { rejectUnauthorized: false },
});

await client.connect();

try {
  await client.query(`
    create table if not exists public.schema_migrations (
      version    text primary key,
      name       text not null,
      applied_at timestamptz not null default now()
    );
  `);

  // One pusher at a time, so two terminals cannot interleave.
  const { rows: lock } = await client.query<{ locked: boolean }>(
    "select pg_try_advisory_lock(hashtext('chaos_league_migrations')) as locked",
  );
  if (!lock[0].locked) {
    console.error("Another migration run is in progress.");
    process.exit(1);
  }

  const files = migrationFiles();

  const { rows: appliedRows } = await client.query<{ version: string }>(
    "select version from public.schema_migrations",
  );
  const applied = new Set(appliedRows.map((r) => r.version));

  if (baselineAt) {
    const toMark = files.filter((f) => versionOf(f) <= baselineAt);
    if (toMark.length === 0) {
      console.error(`No migrations at or before ${baselineAt}.`);
      process.exit(1);
    }

    for (const file of toMark) {
      await client.query(
        `insert into public.schema_migrations (version, name)
         values ($1, $2) on conflict (version) do nothing`,
        [versionOf(file), file],
      );
    }

    console.log(
      `Baselined ${toMark.length} migration(s) up to ${baselineAt} as ` +
        `already applied. Nothing was executed.\n`,
    );
    console.log("Run again without --baseline to apply the rest.");
    process.exit(0);
  }

  for (const version of redo) {
    if (!files.some((f) => versionOf(f) === version)) {
      console.error(`No migration numbered ${version}.`);
      process.exit(1);
    }
  }

  const pending = files.filter(
    (f) => !applied.has(versionOf(f)) || redo.includes(versionOf(f)),
  );

  if (pending.length === 0) {
    console.log(`Up to date: all ${files.length} migrations are applied.`);
    process.exit(0);
  }

  // A database with tables but no history is one that was set up by
  // hand. Applying 0001 to it would be a bad afternoon.
  if (applied.size === 0 && redo.length === 0) {
    const { rows } = await client.query<{ n: string }>(
      `select count(*) as n from information_schema.tables
       where table_schema = 'public' and table_name = 'leagues'`,
    );
    if (Number(rows[0].n) > 0) {
      console.error(
        "This database already has a schema but no migration history.\n\n" +
          "  Record what is already applied first, then push the rest:\n" +
          "    npm run db:push -- --baseline 0023\n",
      );
      process.exit(1);
    }
  }

  console.log(`${pending.length} migration(s) pending:\n`);
  for (const file of pending) console.log(`  ${file}`);

  if (dryRun) {
    console.log("\n--dry-run: nothing was applied.");
    process.exit(0);
  }

  console.log("");

  for (const file of pending) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    process.stdout.write(`  ${file} ... `);

    // Each file is all-or-nothing, so a failure halfway through leaves
    // the schema where it was rather than somewhere in between.
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query(
        `insert into public.schema_migrations (version, name)
         values ($1, $2)
         on conflict (version) do update set applied_at = now()`,
        [versionOf(file), file],
      );
      await client.query("commit");
      console.log("ok");
    } catch (err) {
      await client.query("rollback");
      console.log("FAILED");
      console.error(`\n${(err as Error).message}\n`);
      console.error(
        `Stopped at ${file}. Everything before it is applied and recorded; ` +
          `this one was rolled back.`,
      );
      process.exit(1);
    }
  }

  console.log(`\nApplied ${pending.length} migration(s).`);
} finally {
  await client.end();
}
