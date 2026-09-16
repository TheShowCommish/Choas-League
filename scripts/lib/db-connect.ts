/**
 * Getting a direct Postgres connection to the project.
 *
 * Shared by the scripts that cannot go through PostgREST: db:push, which
 * runs DDL, and the test-league seed, which needs to act as a specific
 * signed-in user rather than as the service role.
 *
 * Deliberately not in lib/test-db.ts: that module pulls in PGlite, and
 * loading a wasm Postgres in order to talk to a real one is silly.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Reads .env.local into process.env. Anything already exported wins, so
 * CI can override the file.
 */
export function loadEnv(path = join(here, "..", "..", ".env.local")) {
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

export interface Connection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/**
 * Splits the connection string by hand rather than handing it to pg.
 *
 * pg parses with `new URL`, which requires the password to be
 * percent-encoded. Database passwords are generated with punctuation in
 * them -- a `/` or a `?` is enough to make the whole string unparseable,
 * and the resulting "Invalid URL" says nothing about why. Since the
 * password is the only field that can contain arbitrary characters, and
 * it is delimited by the first `:` after the scheme and the last `@`,
 * pulling it out literally is both simpler and more forgiving.
 */
export function parseConnectionString(raw: string): Connection {
  const scheme = raw.indexOf("://");
  const at = raw.lastIndexOf("@");
  if (scheme === -1 || at === -1 || at < scheme) {
    throw new Error(
      "SUPABASE_DB_URL does not look like a connection string. It should " +
        "start with postgresql:// and contain an @ before the host.",
    );
  }

  const userinfo = raw.slice(scheme + 3, at);
  const colon = userinfo.indexOf(":");
  const user = colon === -1 ? userinfo : userinfo.slice(0, colon);
  const password = colon === -1 ? "" : userinfo.slice(colon + 1);

  // host[:port][/database][?params]
  let rest = raw.slice(at + 1);
  const query = rest.indexOf("?");
  if (query !== -1) rest = rest.slice(0, query);

  const slash = rest.indexOf("/");
  const database = slash === -1 ? "postgres" : rest.slice(slash + 1) || "postgres";
  const hostPort = slash === -1 ? rest : rest.slice(0, slash);

  const portAt = hostPort.lastIndexOf(":");
  const host = portAt === -1 ? hostPort : hostPort.slice(0, portAt);
  const port = portAt === -1 ? 5432 : Number(hostPort.slice(portAt + 1));

  if (!host) throw new Error("SUPABASE_DB_URL has no host in it.");

  return { host, port, user, password, database };
}

/**
 * The parsed SUPABASE_DB_URL, or a readable exit if it is not set.
 * Also warns about the connection string that silently hangs.
 */
export function requireConnection(): Connection {
  const raw = process.env.SUPABASE_DB_URL;
  if (!raw) {
    console.error(
      "SUPABASE_DB_URL is not set.\n\n" +
        "  Dashboard > Project Settings > Database > Connection string > URI\n" +
        "  Add it to .env.local. It contains your database password, so keep\n" +
        "  it out of commits and out of chat.\n",
    );
    process.exit(1);
  }

  const connection = parseConnectionString(raw);

  // The direct host has no A record, so on an IPv4-only network this
  // hangs rather than failing usefully. Worth saying up front.
  if (/^db\..*\.supabase\.co$/.test(connection.host)) {
    console.log(
      "Note: that is the direct connection, which is IPv6 only. If this " +
        "hangs or times out, use the Session pooler string instead " +
        "(Dashboard > Project Settings > Database > Connection string).\n",
    );
  }

  return connection;
}

/** What pg needs on top of the parsed fields, in one place. */
export const PG_OPTIONS = {
  // Supabase terminates TLS with a certificate chain node does not ship
  // a root for.
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
} as const;
