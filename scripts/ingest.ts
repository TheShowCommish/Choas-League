/**
 * Runs the ingestion jobs from the command line.
 *
 *   npm run ingest -- players
 *   npm run ingest -- games
 *   npm run ingest -- stats            # the current week
 *   npm run ingest -- stats all        # backfill the whole season
 *   npm run ingest -- stats 3
 *   npm run ingest -- all              # players, games, then the season
 *
 * Use this for the first load and for backfills: a full season of stats
 * takes longer than a serverless function is allowed to run. The same
 * code runs behind /api/cron/* for the scheduled jobs.
 *
 * Reads .env.local, so SUPABASE_SERVICE_ROLE_KEY must be set there.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Load .env.local before anything imports the Supabase client.
const here = dirname(fileURLToPath(import.meta.url));
loadEnv(join(here, "..", ".env.local"));

const { syncGames, syncPlayers, syncWeekStats } = await import(
  "../src/lib/ingest/sync.ts"
);
const { currentSeason } = await import("../src/lib/ingest/nflverse.ts");

function loadEnv(path: string) {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    console.warn(`No ${path}; relying on the ambient environment.`);
    return;
  }

  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    // Anything already exported wins, so CI can override the file.
    if (!(key in process.env)) process.env[key] = value;
  }
}

const [command = "all", weekArg] = process.argv.slice(2);
const season = Number(process.env.SEASON) || currentSeason();

console.log(`Season ${season}\n`);

function report(result: { job: string; rows: number; message?: string }) {
  console.log(
    `  ${result.job}: ${result.rows} rows${result.message ? ` (${result.message})` : ""}`,
  );
}

try {
  switch (command) {
    case "players":
      report(await syncPlayers(season));
      break;

    case "games":
      report(await syncGames(season));
      break;

    case "stats": {
      const week =
        weekArg === "all" || weekArg === undefined ? null : Number(weekArg);
      report(await syncWeekStats(season, week));
      break;
    }

    case "all":
      // Players and games first: stat rows reference both.
      report(await syncPlayers(season));
      report(await syncGames(season));
      report(await syncWeekStats(season, null));
      break;

    default:
      console.error(`Unknown command "${command}".`);
      console.error("Try: players | games | stats [week|all] | all");
      process.exit(1);
  }

  console.log("\nDone.");
} catch (err) {
  console.error(`\nFailed: ${(err as Error).message}`);
  process.exit(1);
}
