# Chaos League

A fantasy football site that can score on essentially any statistic the
NFL records, not just the dozen categories the big sites offer.

The scoring catalog has **174 stats** — air yards, yards after contact,
broken tackles, red zone targets, EPA, snap share, IDP tackles, team
defense tiers — and the commissioner sets points-per-unit on each one.
Adding a stat to the catalog makes it scorable with no code change.

Built on Next.js and Supabase. Multi-league from the ground up.

---

## What is here

| Page | What it does |
| --- | --- |
| `/leagues` | Your leagues; create one or join with a code |
| `/l/[id]` | League home: your matchup, standings, recent moves |
| `/l/[id]/my-team` | Set your weekly lineup, drop players, rename your team |
| `/l/[id]/players` | Free agency, blind FAAB bidding, player research |
| `/l/[id]/players/[playerId]` | Every stat a player has recorded, and what each was worth |
| `/l/[id]/trades` | Propose, accept and withdraw trades |
| `/l/[id]/matchups` | The week's games, and a full head-to-head breakdown |
| `/l/[id]/standings` | The table |
| `/l/[id]/transactions` | The full, filterable league audit trail |
| `/l/[id]/draft` | Live draft room, snake or auction (hidden until the commissioner opens it) |
| `/l/[id]/chat` | League message board |
| `/l/[id]/admin` | Scoring, roster shape, settings, and commissioner tools |

Every page is mobile-first: a fixed bottom nav within thumb reach on
phones, 44px tap targets, and wide tables that scroll inside themselves
so the page never scrolls sideways.

---

## Setting it up

### 1. Run the database migrations

In the Supabase dashboard, open **SQL Editor** and run each file in
`supabase/migrations/` **in filename order**, from `0001` to `0018`.
Paste one file at a time and run it.

If you have the Supabase CLI linked to the project, this does the same
thing in one go:

```bash
supabase db push
```

To check the SQL before it touches your project, this applies every
migration to a throwaway in-memory Postgres:

```bash
npm run db:verify
```

### 2. Turn off email confirmation (optional, but easier)

Supabase dashboard → **Authentication → Providers → Email**. If
"Confirm email" is on, everyone has to click a link before their first
sign-in. For a league of friends it is simpler to switch it off.

### 3. Environment variables

`.env.local` already has the project URL and anon key. You need to add
two more values yourself:

```bash
# Supabase dashboard > Project Settings > API > service_role
SUPABASE_SERVICE_ROLE_KEY=

# Any long random string. Protects the /api/cron/* endpoints.
CRON_SECRET=
```

Generate a cron secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The service role key bypasses every security policy in the database.
Keep it out of chat, out of commits, and out of anything the browser can
reach. `.env.local` is gitignored.

### 4. Load the NFL data

The first load pulls ~25,000 players, the full schedule, and a season of
stats. It takes a few minutes — too long for a serverless function, so
run it locally:

```bash
npm run ingest -- all
```

Or one piece at a time:

```bash
npm run ingest -- players
npm run ingest -- games
npm run ingest -- stats all
npm run ingest -- stats 3
```

### 5. Deploy

Import the repo at [vercel.com/new](https://vercel.com/new). Add all
four environment variables in the Vercel project settings (the two from
`.env.local` plus the two you generated). Deploy.

### 6. Turn on the scheduled jobs

`.github/workflows/scheduled-jobs.yml` keeps stats, schedules, lineup
locks and waivers running. In the GitHub repo, go to **Settings →
Secrets and variables → Actions** and add:

| Secret | Value |
| --- | --- |
| `APP_URL` | Your deployed URL, e.g. `https://chaos-league.vercel.app` |
| `CRON_SECRET` | The same value you put in Vercel |

GitHub Actions rather than Vercel Cron because the Vercel Hobby plan
allows only two cron jobs, running once a day — which cannot cover
15-minute lineup locks or hourly waiver processing.

You can run any job by hand from the **Actions** tab → *Scheduled jobs*
→ *Run workflow*.

### 7. Start the league

1. Sign up, then create a league. You are the commissioner.
2. Send everyone the **join code** from the admin page.
3. Set your scoring on the **Scoring** tab. This is the interesting part.
4. Set your roster shape on the **Roster** tab.
5. **Tools** → generate the schedule.
6. **Tools** → pick snake or auction, generate the draft, then open the
   room on the night.
7. When the regular season ends, **Tools** → generate the playoff
   bracket, and advance it as each round goes final.

---

## Scoring

Every stat has a points-per-unit value. `receptions: 1` is full PPR;
`0.5` is half. `passing_yards: 0.04` is the usual 1 point per 25 yards.
Setting a stat to `0` switches it off.

Three kinds of stat:

- **count** — an additive tally. Points = value × your rule.
- **flag** — 0 or 1, emitted when a condition is met. This is how a
  points-per-unit model expresses milestone bonuses: `rush_100_bonus`
  is 1 on a 100-yard game, so setting it to `3` is "+3 for 100 yards".
- **rate** — percentages and per-play averages. Shown for research but
  not scorable, because averaging across games is not the same as
  summing.

Rules can be restricted to positions, which is how you build TE premium:
set `receptions` to 1.5 with positions `['TE']`.

**Scoring changes are retroactive.** After changing scoring, use
**Tools → Recompute all weeks** to re-score the season. Nothing is
recalculated behind your back.

### Stats that are not tracked

173 of the 174 stats are populated. The exception is **rush yards over
expected**, which comes from Next Gen Stats tracking data that is not
published per week. It is flagged in the admin UI, so nobody switches it
on and waits all season for a score that cannot come.

---

## How it fits together

**The database enforces the rules, not the app.** Roster tables have no
write policy at all — every add, drop, waiver award and draft pick goes
through a `SECURITY DEFINER` function that re-checks legality itself, so
the rules cannot be bypassed by talking to the API directly. Reads are
scoped to leagues you belong to. Pending waiver bids are readable only
by the bidding team, which is what makes blind FAAB bidding actually
blind rather than merely hidden by the UI.

**Stats live in a jsonb map, not typed columns.** nflverse publishes a
very wide and growing stat surface, and only the stats a player actually
recorded are stored. A jsonb map means a new stat needs a catalog entry,
not a migration.

**Scoring is a join, not a formula.** `recompute_week_scores` matches
every stat key in a player's line against the league's rule table and
multiplies. There is no hard-coded notion of what a touchdown is worth.

**A team defense is just a player** with the id `DST_KC` and position
`DEF`. That keeps every roster, lineup, draft, waiver and scoring query
on a single code path.

**Playoff seeds are frozen** when the bracket is generated. Standings
keep moving as consolation games finish, and a bracket that re-seeds
itself underneath you is a good way to start an argument in December.

### Data sources

- [nflverse](https://github.com/nflverse/nflverse-data) — players,
  schedules, weekly box scores, team stats, snap counts, Pro Football
  Reference advanced charting, and full play-by-play. Free, no key,
  updated within hours of a game.
- **ESPN**'s public box scores, polled every five minutes during games
  for live scoring. Narrower and less accurate than nflverse, so a live
  stat line is always replaced by the official one later and never the
  other way round.

Situational stats — red zone targets, carries inside the five, deep
attempts, three-and-outs — exist only as properties of individual plays,
so they come from walking the season's play-by-play. It is 18MB gzipped
and takes about four seconds to aggregate a week.

---

## Development

```bash
npm run dev          # http://localhost:3000
npm test             # logic and ingestion tests
npm run db:verify    # apply the migrations to a scratch Postgres
npm run lint
npm run build
```

### Tests

`scripts/league-logic.test.ts` runs the real migrations against an
in-memory Postgres (PGlite — no Docker) and exercises the PL/pgSQL:
scoring, waivers, drafts, trades, roster legality, schedule generation.

`scripts/ingest.test.ts` checks the nflverse mapping against live data.
The load-bearing test scores 300 real players from our mapped stats and
requires the total to match nflverse's own `fantasy_points_ppr` to
within 0.5 points — a renamed column or mistyped stat key would
otherwise look exactly like a quiet week.

### Changing the stat catalog

`src/lib/stats/catalog.ts` is the single source of truth. After editing:

```bash
npm run gen:stat-seed
```

That regenerates `supabase/migrations/0010_seed_stat_definitions.sql`.
Run it against the database, and add the mapping in
`src/lib/ingest/map-stats.ts` so something actually populates it.
