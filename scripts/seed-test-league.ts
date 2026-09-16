/**
 * Builds "Fake Test League": twelve teams, full rosters, a played-out
 * 2025 season.
 *
 *   npm run seed:test-league
 *   npm run seed:test-league -- --email you@example.com
 *   npm run seed:test-league -- --keep-regular-season
 *
 * What it is for: every screen in this app is empty until a league has
 * been drafted and a season has been played, which makes anything past
 * the setup pages impossible to look at. This produces one in about a
 * minute, with real 2025 stat lines behind it, so the standings, the
 * matchups, the bracket and the player pages all have something in them.
 *
 * Re-running it deletes the previous Fake Test League and builds a new
 * one, so it is safe to run repeatedly. It will not touch any other
 * league.
 *
 * Needs a direct Postgres connection (SUPABASE_DB_URL in .env.local, the
 * same one db:push uses), not the service-role key. The functions that
 * build a schedule and a bracket check `is_commissioner`, which reads
 * auth.uid(); the service role has no auth.uid() at all, so those calls
 * fail for it. Over a direct connection the request's JWT claims can be
 * set to the commissioner, and the real code paths run exactly as they
 * would for somebody clicking the buttons in the admin page.
 *
 * It also needs 2025 stats already ingested:
 *
 *   SEASON=2025 npm run ingest -- players
 *   SEASON=2025 npm run ingest -- games
 *   SEASON=2025 npm run ingest -- stats all
 */
import pg from "pg";
import { loadEnv, PG_OPTIONS, requireConnection } from "./lib/db-connect.ts";

loadEnv();

const LEAGUE_NAME = "Fake Test League";
const SEASON = 2025;
const TEAM_COUNT = 12;
const REGULAR_SEASON_WEEKS = 14;
const PLAYOFF_START_WEEK = 15;
const PLAYOFF_TEAMS = 6;

/**
 * The squad every team is drafted to, in the order positions are filled.
 *
 * Sixteen players against the default roster -- QB, 2 RB, 2 WR, TE,
 * FLEX, K, D/ST and seven bench -- and inside this league's position
 * caps, which the roster_players trigger enforces whatever this file
 * thinks. Two at quarterback and tight end rather than one so there is
 * a bench worth looking at, which is half the point of the bench score.
 */
const SQUAD: Record<string, number> = {
  QB: 2,
  RB: 5,
  WR: 5,
  TE: 2,
  K: 1,
  DEF: 1,
};

/** How many of each a team may hold at all, from the league defaults. */
const POSITION_CAP: Record<string, number> = {
  QB: 4,
  RB: 8,
  WR: 8,
  TE: 4,
  K: 3,
  DEF: 3,
};

/**
 * Twelve franchises with names, cities and a pair of colours each.
 *
 * The colours are the reason they are spelled out rather than generated:
 * the team theme and both matchup views paint with them, and a set of
 * evenly spaced hues is the quickest way to see whether any of that
 * actually reads.
 */
const TEAMS = [
  { name: "Gridiron Chaos", city: "Akron", abbr: "CHA", color: "#e03131", secondary: "#7a1010" },
  { name: "Neon Narwhals", city: "Boise", abbr: "NAR", color: "#22b8cf", secondary: "#0b525b" },
  { name: "Cascade Coyotes", city: "Cascade", abbr: "COY", color: "#f08c00", secondary: "#7a4600" },
  { name: "Dust Bowl Dynamos", city: "Dodge City", abbr: "DYN", color: "#7048e8", secondary: "#33228a" },
  { name: "Emerald Eels", city: "Eugene", abbr: "EEL", color: "#2f9e44", secondary: "#14532d" },
  { name: "Foghorn Ferrets", city: "Fresno", abbr: "FER", color: "#e64980", secondary: "#7b1f45" },
  { name: "Granite Goats", city: "Concord", abbr: "GOA", color: "#868e96", secondary: "#343a40" },
  { name: "Harbor Hornets", city: "Halifax", abbr: "HOR", color: "#fab005", secondary: "#7a5500" },
  { name: "Iron Ibises", city: "Indianola", abbr: "IBI", color: "#1971c2", secondary: "#0b3d69" },
  { name: "Jackrabbit Juggernauts", city: "Joplin", abbr: "JUG", color: "#12b886", secondary: "#0a5c45" },
  { name: "Kettle Kraken", city: "Kalamazoo", abbr: "KRA", color: "#4c6ef5", secondary: "#243b8a" },
  { name: "Lantern Lynx", city: "Laramie", abbr: "LYN", color: "#be4bdb", secondary: "#5f2470" },
];

interface Candidate {
  id: string;
  position: string;
  points: number;
}

const args = process.argv.slice(2);
const email = readFlag("--email");
/** Stop after the regular season, rather than playing the bracket out. */
const keepRegularSeason = args.includes("--keep-regular-season");

function readFlag(name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    console.error(`${name} needs a value, e.g. ${name} you@example.com`);
    process.exit(1);
  }
  return value;
}

const client = new pg.Client({ ...requireConnection(), ...PG_OPTIONS });
await client.connect();

try {
  const commissioner = await resolveCommissioner();
  console.log(`Commissioner: ${commissioner.display_name} <${commissioner.email}>`);

  // Everything from here on runs as that person, so the security-definer
  // functions see the commissioner they check for.
  await client.query(
    `select set_config('request.jwt.claims',
       json_build_object('sub', $1::text, 'role', 'authenticated')::text,
       false)`,
    [commissioner.id],
  );

  const weeks = await statWeeks();
  if (weeks.length === 0) {
    console.error(
      `No ${SEASON} stats in the database, so there is nothing to seed a ` +
        `season from.\n\n` +
        `  SEASON=${SEASON} npm run ingest -- players\n` +
        `  SEASON=${SEASON} npm run ingest -- games\n` +
        `  SEASON=${SEASON} npm run ingest -- stats all\n`,
    );
    process.exit(1);
  }
  console.log(`${SEASON} stats cover ${weeks.length} weeks.`);

  const leagueId = await createLeague(commissioner.id);
  console.log(`Created ${LEAGUE_NAME} (${leagueId}).`);

  await nameTeams(leagueId, commissioner.id);
  const teamIds = await teamOrder(leagueId);

  const pool = await candidates(leagueId);
  const squad = planSquad(pool);
  const rosters = await draft(leagueId, teamIds, squad, pool);
  console.log(
    `Drafted ${[...rosters.values()].reduce((n, r) => n + r.length, 0)} players ` +
      `across ${teamIds.length} teams.`,
  );

  await setLineups(leagueId, rosters, weeks);
  console.log(`Set lineups for weeks ${weeks[0]}-${weeks[weeks.length - 1]}.`);

  const games = await client.query<{ generate_schedule: number }>(
    "select public.generate_schedule($1) as generate_schedule",
    [leagueId],
  );
  console.log(`Scheduled ${games.rows[0].generate_schedule} regular season games.`);

  for (let week = 1; week <= REGULAR_SEASON_WEEKS; week++) {
    await client.query("select public.finalize_week($1, $2, $3)", [
      leagueId,
      SEASON,
      week,
    ]);
  }
  console.log(`Played out weeks 1-${REGULAR_SEASON_WEEKS}.`);

  if (keepRegularSeason) {
    await client.query(
      "update public.leagues set current_week = $2 where id = $1",
      [leagueId, REGULAR_SEASON_WEEKS],
    );
  } else {
    await playPlayoffs(leagueId);
  }

  const { rows: summary } = await client.query<{
    join_code: string;
    current_week: number;
    status: string;
  }>(
    "select join_code, current_week, status from public.leagues where id = $1",
    [leagueId],
  );

  console.log(
    `\nDone. ${LEAGUE_NAME} is at week ${summary[0].current_week} ` +
      `(${summary[0].status}).\n` +
      `  /l/${leagueId}\n` +
      `  join code ${summary[0].join_code} -- for a second account to take a team\n`,
  );
} finally {
  await client.end();
}

/** Whose league this is: the given email, or the only account there is. */
async function resolveCommissioner() {
  if (email) {
    const { rows } = await client.query<{
      id: string;
      email: string;
      display_name: string;
    }>("select id, email, display_name from public.profiles where email = $1", [
      email,
    ]);
    if (rows.length === 0) {
      console.error(`No account with the email ${email}. Sign up first.`);
      process.exit(1);
    }
    return rows[0];
  }

  const { rows } = await client.query<{
    id: string;
    email: string;
    display_name: string;
  }>("select id, email, display_name from public.profiles order by email");

  if (rows.length === 0) {
    console.error(
      "There are no accounts yet. Sign up in the app first -- a league " +
        "needs a commissioner to belong to.",
    );
    process.exit(1);
  }
  if (rows.length > 1) {
    console.log(
      `${rows.length} accounts; using the first. Pass --email to pick.`,
    );
  }
  return rows[0];
}

/**
 * The weeks we hold stat lines for, in order.
 *
 * Regular season only. A stat table also carries the NFL's own playoff
 * weeks, numbered 19 and up, and a fantasy season that ends at week 17
 * has no use for lineups in them.
 */
async function statWeeks(): Promise<number[]> {
  const { rows } = await client.query<{ week: number }>(
    `select distinct week from public.player_game_stats
     where season = $1 and season_type = 'REG' and week <= 18
     order by week`,
    [SEASON],
  );
  return rows.map((r) => r.week);
}

/**
 * Drops any previous run and inserts the league.
 *
 * The insert is all it takes: triggers on `leagues` seed the roster
 * slots, the scoring rules, the position limits, the commissioner's
 * membership, twelve placeholder teams, and then score the whole season
 * that has already been ingested. That last one is why this statement
 * takes a few seconds.
 */
async function createLeague(commissionerId: string): Promise<string> {
  const { rowCount } = await client.query(
    "delete from public.leagues where name = $1 and season = $2",
    [LEAGUE_NAME, SEASON],
  );
  if (rowCount) console.log("Removed the previous Fake Test League.");

  const { rows } = await client.query<{ id: string }>(
    `insert into public.leagues
       (name, season, commissioner_id, team_count, current_week,
        regular_season_weeks, playoff_start_week, playoff_teams, status)
     values ($1, $2, $3, $4, 1, $5, $6, $7, 'in_season')
     returning id`,
    [
      LEAGUE_NAME,
      SEASON,
      commissionerId,
      TEAM_COUNT,
      REGULAR_SEASON_WEEKS,
      PLAYOFF_START_WEEK,
      PLAYOFF_TEAMS,
    ],
  );
  return rows[0].id;
}

/** Gives the placeholder teams identities, and the first one an owner. */
async function nameTeams(leagueId: string, commissionerId: string) {
  for (const [index, team] of TEAMS.entries()) {
    await client.query(
      `update public.teams
          set name = $3, city = $4, abbreviation = $5,
              color = $6, secondary_color = $7,
              owner_id = case when $8::boolean then $9::uuid else owner_id end
        where league_id = $1 and slot_number = $2`,
      [
        leagueId,
        index + 1,
        team.name,
        team.city,
        team.abbr,
        team.color,
        team.secondary,
        index === 0,
        commissionerId,
      ],
    );
  }
}

/** Team ids in draft order -- the order the seeding trigger made them. */
async function teamOrder(leagueId: string): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `select id from public.teams where league_id = $1
     order by slot_number nulls last, created_at`,
    [leagueId],
  );
  return rows.map((r) => r.id);
}

/**
 * How many of each position each team can actually be given.
 *
 * SQUAD is the intention; this is what the pool supports. A database
 * with no team-defence stats has no draftable D/ST, and a plan that
 * insists on twelve of them would fail on the last pick of a two minute
 * script. Any shortfall goes to running backs and receivers, which every
 * pool has plenty of, up to this league's caps.
 */
function planSquad(pool: Candidate[]): Record<string, number> {
  const plan: Record<string, number> = {};
  let shortfall = 0;

  for (const [position, wanted] of Object.entries(SQUAD)) {
    const supply = pool.filter((p) => p.position === position).length;
    const possible = Math.min(wanted, Math.floor(supply / TEAM_COUNT));
    plan[position] = possible;
    if (possible < wanted) {
      shortfall += wanted - possible;
      console.log(
        `Only ${supply} ${position}s have ${SEASON} stats, so teams get ` +
          `${possible} each rather than ${wanted}.`,
      );
    }
  }

  // Spread whatever is missing over the two deepest positions.
  for (const position of ["RB", "WR"]) {
    while (shortfall > 0) {
      const supply = pool.filter((p) => p.position === position).length;
      if (
        plan[position] >= POSITION_CAP[position] ||
        (plan[position] + 1) * TEAM_COUNT > supply
      ) {
        break;
      }
      plan[position] += 1;
      shortfall -= 1;
    }
  }

  return plan;
}

/**
 * Everyone with a 2025 stat line, best first.
 *
 * "Best" is what they scored under this league's own rules, which is the
 * ranking a real draft board would show. Games played breaks ties so a
 * man who played one week does not outrank a man who played seventeen
 * for the same total.
 */
async function candidates(leagueId: string): Promise<Candidate[]> {
  const { rows } = await client.query<Candidate>(
    `with played as (
       select player_id, count(*) as games
       from public.player_game_stats
       where season = $2
       group by player_id
     ),
     scored as (
       select player_id, sum(points) as points
       from public.player_week_scores
       where league_id = $1 and season = $2
       group by player_id
     )
     select p.id, p.position, coalesce(sc.points, 0)::float8 as points
     from public.nfl_players p
     join played pl on pl.player_id = p.id
     left join scored sc on sc.player_id = p.id
     where p.position = any($3::text[])
     order by coalesce(sc.points, 0) desc, pl.games desc, p.full_name`,
    [leagueId, SEASON, Object.keys(SQUAD)],
  );
  return rows;
}

/**
 * A snake draft over the ranked pool.
 *
 * Each pick takes the best player left at a position the team still
 * needs, which is roughly how a real draft goes and, more usefully here,
 * guarantees every team ends up with a legal starting lineup rather than
 * eleven quarterbacks.
 */
async function draft(
  leagueId: string,
  teamIds: string[],
  squad: Record<string, number>,
  pool: Candidate[],
): Promise<Map<string, Candidate[]>> {
  const byPosition = new Map<string, Candidate[]>();
  for (const player of pool) {
    const list = byPosition.get(player.position) ?? [];
    list.push(player);
    byPosition.set(player.position, list);
  }

  const rosters = new Map<string, Candidate[]>(teamIds.map((id) => [id, []]));
  const needs = new Map(teamIds.map((id) => [id, { ...squad }]));
  const rounds = Object.values(squad).reduce((n, count) => n + count, 0);

  for (let round = 0; round < rounds; round++) {
    const order = round % 2 === 0 ? teamIds : [...teamIds].reverse();

    for (const teamId of order) {
      const need = needs.get(teamId)!;

      // Best player available at any position the team still has room
      // for. Kickers and defences fall to the late rounds on their own,
      // because that is where they sit on a board ranked by points --
      // there is no rule here putting them there.
      let position: string | null = null;
      for (const candidate of Object.keys(squad)) {
        if (need[candidate] <= 0) continue;
        const best = byPosition.get(candidate)?.[0];
        if (!best) continue;
        if (position === null || best.points > byPosition.get(position)![0].points) {
          position = candidate;
        }
      }

      if (position === null) continue;

      const player = byPosition.get(position)!.shift()!;
      need[position] -= 1;
      rosters.get(teamId)!.push(player);
    }
  }

  // One statement rather than 192: unnest turns the arrays into rows.
  const teamColumn: string[] = [];
  const playerColumn: string[] = [];
  for (const [teamId, players] of rosters) {
    for (const player of players) {
      teamColumn.push(teamId);
      playerColumn.push(player.id);
    }
  }

  await client.query(
    `insert into public.roster_players (league_id, team_id, player_id, acquired_via)
     select $1, t.team_id::uuid, t.player_id, 'draft'
     from unnest($2::uuid[], $3::text[]) as t(team_id, player_id)`,
    [leagueId, teamColumn, playerColumn],
  );

  return rosters;
}

/**
 * Puts a lineup out for every week of the season.
 *
 * The same lineup every week, chosen on season-long production, rather
 * than the best possible one week by week. A test league where every
 * manager was perfect in hindsight has no bench points in it, and the
 * bench score is one of the things this data exists to show.
 */
async function setLineups(
  leagueId: string,
  rosters: Map<string, Candidate[]>,
  weeks: number[],
) {
  const teamColumn: string[] = [];
  const weekColumn: number[] = [];
  const playerColumn: string[] = [];
  const slotColumn: string[] = [];

  for (const [teamId, players] of rosters) {
    const remaining = [...players].sort((a, b) => b.points - a.points);
    const assignments: { player: Candidate; slot: string }[] = [];

    /** Takes the best remaining player matching any of these positions. */
    const take = (positions: string[], slot: string) => {
      const index = remaining.findIndex((p) => positions.includes(p.position));
      if (index === -1) return;
      assignments.push({ player: remaining.splice(index, 1)[0], slot });
    };

    take(["QB"], "QB");
    take(["RB"], "RB");
    take(["RB"], "RB");
    take(["WR"], "WR");
    take(["WR"], "WR");
    take(["TE"], "TE");
    take(["RB", "WR", "TE"], "FLEX");
    take(["K"], "K");
    take(["DEF"], "DEF");

    // Whatever is left rides the bench, best first.
    for (const player of remaining) assignments.push({ player, slot: "BN" });

    for (const week of weeks) {
      for (const { player, slot } of assignments) {
        teamColumn.push(teamId);
        weekColumn.push(week);
        playerColumn.push(player.id);
        slotColumn.push(slot);
      }
    }
  }

  await client.query(
    `insert into public.lineup_entries
       (league_id, team_id, season, week, player_id, slot_key)
     select $1, t.team_id::uuid, $2, t.week, t.player_id, t.slot_key
     from unnest($3::uuid[], $4::int[], $5::text[], $6::text[])
       as t(team_id, week, player_id, slot_key)
     on conflict (team_id, season, week, player_id) do nothing`,
    [leagueId, SEASON, teamColumn, weekColumn, playerColumn, slotColumn],
  );
}

/**
 * Runs the bracket to a champion, one round at a time, exactly the way
 * a commissioner would from the admin page: finalise the round's weeks,
 * then advance it.
 */
async function playPlayoffs(leagueId: string) {
  await client.query(
    "update public.leagues set current_week = $2 where id = $1",
    [leagueId, PLAYOFF_START_WEEK],
  );

  const created = await client.query<{ generate_playoffs: number }>(
    "select public.generate_playoffs($1) as generate_playoffs",
    [leagueId],
  );
  console.log(`Bracket generated: ${created.rows[0].generate_playoffs} games.`);

  // A guard rather than `while (true)`: a bracket that somehow stops
  // resolving should end the script, not spin against the database.
  for (let round = 0; round < 6; round++) {
    const { rows: league } = await client.query<{
      current_week: number;
      status: string;
    }>("select current_week, status from public.leagues where id = $1", [
      leagueId,
    ]);
    if (league[0].status === "complete") break;

    const week = league[0].current_week;
    const { rows: span } = await client.query<{ first: number; last: number }>(
      `select min(week) as first, max(week + week_count - 1) as last
       from public.matchups
       where league_id = $1 and season = $2 and is_playoff
         and $3 between week and week + week_count - 1`,
      [leagueId, SEASON, week],
    );
    if (span[0].first === null) break;

    for (let w = span[0].first; w <= span[0].last; w++) {
      await client.query("select public.finalize_week($1, $2, $3)", [
        leagueId,
        SEASON,
        w,
      ]);
    }

    await client.query("select public.advance_playoffs($1, $2)", [
      leagueId,
      week,
    ]);
    console.log(`Played playoff week ${week}.`);
  }
}
