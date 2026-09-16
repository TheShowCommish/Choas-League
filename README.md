# Chaos League

A fantasy football site that can score on essentially any statistic the
NFL records, not just the dozen categories the big sites offer.

The scoring catalog has **220 stats** — air yards, yards after contact,
broken tackles, red zone targets, EPA, snap share, team defense tiers,
sacks allowed by an offensive line — and the commissioner sets
points-per-unit on each one.
Adding a stat to the catalog makes it scorable with no code change.

Built on Next.js and Supabase. Multi-league from the ground up.

---

## What is here

| Page | What it does |
| --- | --- |
| `/leagues` | Your leagues; create one or join with a code |
| `/l/[id]` | League home: your matchup, standings, recent moves |
| `/l/[id]/my-team` | Your lineup, your week's opponent, and your team's colours |
| `/l/[id]/players` | Free agency, blind FAAB bidding, player research |
| `/l/[id]/players/[playerId]` | A player's stats, his own news, and how hurt he is |
| `/l/[id]/trades` | Propose, accept and withdraw trades |
| `/l/[id]/matchups` | The week's games, and a full head-to-head breakdown |
| `/l/[id]/standings` | The table |
| `/l/[id]/transactions` | The full, filterable league audit trail |
| `/l/[id]/draft` | Live draft room, snake or auction (hidden until the commissioner opens it) |
| `/l/[id]/chat` | League message board |
| `/l/[id]/admin` | Scoring, roster shape, settings, and commissioner tools |

Every page is mobile-first: a fixed bottom nav within thumb reach on
phones, 44px tap targets, and wide tables that scroll inside themselves
so the page never scrolls sideways. The draft room is the one exception
-- it takes the whole screen, because three panels working at once have
no width to spare.

---

## Setting it up

### 1. Run the database migrations

Add `SUPABASE_DB_URL` to `.env.local`. Get it from Dashboard > Project
Settings > Database > Connection string, and **copy the Session pooler
one** -- the direct connection is IPv6-only and will not reach most home
networks, while the transaction pooler on port 6543 cannot hold the
advisory lock the push takes. Replace only the password placeholder;
leave the rest of the string exactly as the dashboard gives it, since
the pooler's username is `postgres.<ref>` rather than `postgres`.

Then:

```bash
npm run db:push
```

That applies everything outstanding and records it in
`public.schema_migrations`, so it is safe to re-run. `--dry-run` lists
what would happen without doing it.

**On a database whose schema was set up by hand**, tell it what is
already there before pushing, or it will try to apply `0001` to a
database that already has it:

```bash
npm run db:push -- --baseline 0023
```

`0010` is generated from the stat catalog and rewritten whenever a stat
is added, so re-run it after regenerating rather than leaving history to
claim it is done:

```bash
npm run db:push -- --redo 0010
```

You can still paste files into the dashboard **SQL Editor** by hand, in
filename order from `0001` to `0035`, if you would rather.

To check the SQL before it touches your project, this applies every
migration to a throwaway in-memory Postgres and touches nothing real:

```bash
npm run db:verify
```

### 2. Turn off email confirmation

Supabase dashboard → **Authentication → Providers → Email** → turn
**"Confirm email"** off.

Do this before inviting anyone. Supabase's built-in mailer is rate
limited to a couple of messages an hour on the free tier, so with
confirmation on, a league signing up together will hit the limit and the
stragglers simply never receive their link. With it off, `signUp`
returns a session immediately and the signup page drops the new manager
straight into the app -- that path is already handled in
`src/app/signup/page.tsx`, so no code change is needed either way.

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
npm run ingest -- adp                 # mock-draft average draft position
npm run ingest -- season-projections  # what this year is expected to bring
npm run ingest -- injuries            # who is hurt, and with what
```

The last three all match against the player table, so run them after
`players`. `all` already does them in that order. ADP and the season
projections are worth re-running through August, when the board moves
every time somebody gets hurt in camp; injuries are worth running
several times a week once the season starts, because a Friday practice
report lands hours before kickoff.

### 4b. A league to look at (optional)

Every screen past the setup pages is empty until a league has drafted
and played. This builds one — twelve teams, full rosters, a played-out
2025 season with a real bracket at the end of it:

```bash
npm run seed:test-league
```

It is called **Fake Test League**, and re-running the script replaces
it and touches nothing else. Needs `SUPABASE_DB_URL` (the same one
`db:push` uses) and the 2025 stats loaded above; pass
`-- --email you@example.com` if more than one account exists, and
`-- --keep-regular-season` to stop before the playoffs.

### 5. Deploy

Import the repo at [vercel.com/new](https://vercel.com/new). Add all
four environment variables in the Vercel project settings (the two from
`.env.local` plus the two you generated). Deploy.

### 6. Turn on the scheduled jobs

`.github/workflows/scheduled-jobs.yml` keeps stats, schedules, ADP,
projections, injuries, lineup locks and waivers running. In the GitHub repo, go to **Settings →
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

## The draft room

The board runs down the left: every pick slot of every round in one
column, already made, on the clock and still to come. It scrolls itself
to the current pick as the draft moves, which is why it is a column —
a wide grid cannot follow anything.

The room uses the whole screen rather than the reading column the rest
of the app sits in: three panels are working at once and none of them
has width to spare.

Players are sorted by **ADP** by default, and can be sorted by this
season's projection or last season's points instead. Every row carries
the player's positional rank among those still on the board, his bye
week, and his injury designation. "Flex" is offered as a position filter
and expands to whatever this league's flex slots actually accept, rather
than assuming RB/WR/TE.

The right-hand column is your queue and a roster view.

**Autodraft** is no longer a mystery. Each manager chooses their own
rule for what happens when their queue has nobody due — best available
by ADP, most points last season, or most projected points this season —
and the room names the player it would actually take, asked of the same
database function that will make the pick. A queue entry can still name
the earliest round it may be taken in, so a round-seven sleeper sits at
the top of the queue from round one without any risk of autopick
spending a first-rounder on him.

The roster view slots each pick into the league's own roster shape, so
the empty rows are the positions you are still short of, with a tally
across the top of how many of each position are already in. A selector
switches it to any other team — seeing that the manager picking ahead of
you already has two quarterbacks is worth knowing before you reach for
your own. Your own queue stays private: asking what autodraft would do
for somebody else's team returns nothing.

### Queues and target rounds

A queued player can name **the earliest round he may be taken in**.
Autopick walks the queue in order, skips anybody whose round has not
arrived, and takes the first who is due. If nobody is due it falls
through to that manager's own chosen rule — ADP, last season, or this
season's projection — with the other two as tiebreaks, because any one
measure is silent about somebody: ADP says nothing about a player nobody
is drafting, last season says nothing about a rookie, and a projection
says nothing about anyone the feed skipped.

You can also draft straight out of the queue, which is the point of
building one during the rounds before yours.

---

## Your team

The **My Team** page wears your colours. Every manager picks a main and
an accent colour and can upload a crest, which then appears in the
corner of the page, on the matchup preview, and anywhere else the team
turns up; the settings that control all of it sit behind an **Edit**
button next to the team name rather than at the bottom of the page.

Above the lineup is the week's opponent, with both records and the live
score, because every lineup decision is a decision against somebody and
sending people to another tab to find out who made the two halves of one
question live on different pages.

Nobody sits outside the lineup. A player with no slot is dealt into one
when the page loads — the best available into each empty starting spot,
everyone else onto the bench — so "on the roster but nowhere" is not a
state anybody discovers on a Sunday morning. The only players left over
are the ones a full roster genuinely has no room for, and the page says
so in those words.

---

## A player's page

Stats across the top, news down the right, the full stat table at the
bottom. The news is that player's own: ESPN's league feed accepts an
`athlete` parameter and quietly ignores it, so this reads the athlete
overview endpoint instead and filters again on the athlete categories
each article carries.

Anybody hurt gets a badge beside his name saying what the designation
is and what is hurt, and a panel saying what that means for
availability — injured reserve is four games minimum, doubtful is about
one in four, questionable is decided close to kickoff — how long he has
carried it, how practice has gone, and the beat writer's line on the
timeline where there is one.

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

219 of the 220 stats are populated. The exception is **rush yards over
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

**A team unit is just a player.** A defense is `DST_KC`, position
`DEF`; an offensive line is `OL_NYG`, position `OL`; a head coach is
`HC_KC`, position `HC`. That keeps every roster, lineup, draft, waiver
and scoring query on a single code path — an offensive line is drafted,
benched, traded and scored by the same SQL as a wide receiver, and the
scoring engine needed no changes at all to start scoring one.

**Individual defenders and individual offensive linemen are not in the
pool.** Both are rostered as the unit instead, the way ESPN has always
done defenses. `is_fantasy_player` is the single place that decides,
and the draft board, free agency and autopick all ask it.

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
- **Fantasy Football Calculator**, for draft order. It publishes ADP
  averaged over the thousands of public mock drafts it runs all summer,
  which is the number the board opens on: sorting by last season's
  points would bury every rookie and everybody who missed a year. A
  twelve-team fifteen-round board only names about 270 players, though,
  which is where the second source comes in.
- **ESPN**'s fantasy player service, for the rest of the board. Twelve
  hundred players deep, so it fills in everybody the mock drafts never
  reached and the late rounds have an order instead of an alphabet. ESPN
  only publishes a real average draft position while people are actually
  drafting on ESPN — the rest of the year every player comes back with
  the same placeholder number, so the ingestion detects that and falls
  back to ESPN's own PPR draft rank. `nfl_players.adp_source` records
  which of the three a row came from, and the stored rank is renumbered
  over the merged list so it can never disagree with the stored ADP.
- **Sleeper**, for projections and injuries. Projections are stored as a
  projected *stat line* rather than a points total — weekly and for the
  whole season — because a points total is projected under somebody
  else's scoring and means nothing in a league that pays 50 for a
  quarterback's tackle. Storing the line lets it be scored through the
  same rule table as a real game, so what the draft board and the player
  page show is a projection *in your league*. Their player dump is also
  the only free feed carrying the body part and the practice report
  beside the designation, which between them are what actually answer
  "is he playing on Sunday".
- **ESPN**'s athlete overview, for player news. Not the league news feed:
  it accepts an `athlete` parameter and ignores it, so every player's
  page showed the same league-wide headlines. The overview endpoint is
  scoped to the player, and carries a Rotowire blurb — the closest any
  free feed comes to saying how long an injury will last.

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

npm run seed:test-league   # a played-out 12-team league to click around
```

### Tests

`scripts/league-logic.test.ts`, `auction.test.ts` and `playoffs.test.ts`
run the real migrations against an in-memory Postgres (PGlite — no
Docker) and exercise the PL/pgSQL: scoring, waivers, drafts, trades,
roster legality, schedule and bracket generation.

`scripts/rls.test.ts` is the one that matters most. It runs as the
`authenticated` role with `FORCE ROW LEVEL SECURITY` on every table, so
the policies are actually enforced rather than bypassed, and checks the
guarantees the whole app rests on: you only see leagues you belong to,
you can only control your own team, and nobody — not even the
commissioner — can see a pending waiver bid.

That suite immediately found a showstopper: creating a league was
impossible for any normal user, because the triggers that seed the
commissioner's membership and the default roster ran as the caller and
were blocked by the very policies they needed to satisfy. Every other
test ran as superuser and so never saw it. Fixed in migration 0021.

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
`src/lib/ingest/map-stats.ts` so something actually populates it:

```bash
npm run db:push -- --redo 0010
```

The generated file ends by giving every existing league a rule for
anything newly added, so a catalog change reaches leagues that already
exist rather than only new ones.

It also **begins** by asserting the `applies_to` check constraint, which
matters more than it looks. `--redo 0010` re-runs the seed ahead of
every migration numbered above it, so anything the seed's own rows need
has to be in the seed. Putting a new `applies_to` value in the catalog
and widening the constraint in a later migration fails, which is exactly
what happened when the O-line stats were added. `STAT_APPLIES_TO` in the
catalog is what the constraint is emitted from, so the two cannot drift.
`scripts/migration-order.test.ts` covers it.
