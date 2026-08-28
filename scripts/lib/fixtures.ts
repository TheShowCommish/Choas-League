/**
 * Shared fixtures for the database tests: a league with four teams, and
 * helpers for inventing players and stat lines.
 */
import type { TestDb } from "./test-db.ts";

export const SEASON = 2026;

/** A commissioner, three managers, a league, four teams. */
export interface Fixture {
  commish: string;
  managers: string[];
  leagueId: string;
  teamIds: string[];
}

/**
 * Builds a league with four owned teams.
 *
 * `overrides` is raw SQL appended to an UPDATE on the league, for the
 * settings a test needs to differ (waiver type, budget and so on).
 */
export async function buildLeague(
  db: TestDb,
  name: string,
  overrides = "",
): Promise<Fixture> {
  const commish = await db.createUser(`commish-${name}@example.com`, "Commish");
  await db.actAs(commish);

  const league = await db.one<{ id: string; join_code: string }>(
    `insert into public.leagues (name, season, commissioner_id)
     values ($1, $2, $3) returning id, join_code`,
    [name, SEASON, commish],
  );

  if (overrides) {
    await db.exec(
      `update public.leagues set ${overrides} where id = '${league.id}'`,
    );
  }

  // The commissioner needs a team too.
  const commishTeam = await db.one<{ join_league: string }>(
    "select public.join_league($1, $2) as join_league",
    [league.join_code, "Commish Team"],
  );

  const managers: string[] = [];
  const teamIds: string[] = [commishTeam.join_league];

  for (let i = 1; i <= 3; i++) {
    const uid = await db.createUser(`mgr${i}-${name}@example.com`, `Manager ${i}`);
    await db.actAs(uid);
    const team = await db.one<{ join_league: string }>(
      "select public.join_league($1, $2) as join_league",
      [league.join_code, `Team ${i}`],
    );
    managers.push(uid);
    teamIds.push(team.join_league);
  }

  await db.actAs(commish);
  return { commish, managers, leagueId: league.id, teamIds };
}

export async function makePlayer(
  db: TestDb,
  id: string,
  name: string,
  position: string,
  team = "KC",
): Promise<string> {
  await db.q(
    `insert into public.nfl_players (id, full_name, position, team_abbr)
     values ($1, $2, $3, $4) on conflict (id) do nothing`,
    [id, name, position, team],
  );
  return id;
}

/** Invents an NFL game and a stat line for a player in it. */
export async function giveStats(
  db: TestDb,
  playerId: string,
  week: number,
  stats: Record<string, number>,
  source: "live" | "final" = "final",
): Promise<void> {
  const gameId = `${SEASON}_${String(week).padStart(2, "0")}_TEST_${playerId}`;

  await db.q(
    `insert into public.nfl_games (id, season, week, home_team, away_team, status)
     values ($1, $2, $3, 'KC', 'BUF', 'final')
     on conflict (id) do nothing`,
    [gameId, SEASON, week],
  );

  await db.q(
    `insert into public.player_game_stats
       (player_id, game_id, season, week, stats, source)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (player_id, game_id) do update
       set stats = excluded.stats, source = excluded.source`,
    [playerId, gameId, SEASON, week, JSON.stringify(stats), source],
  );
}

/** The owner of a team, for tests that need to act as them. */
export async function ownerOf(db: TestDb, teamId: string): Promise<string> {
  const row = await db.one<{ owner_id: string }>(
    "select owner_id from public.teams where id = $1",
    [teamId],
  );
  return row.owner_id;
}
