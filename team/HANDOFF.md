# Handoff — 2026-10-01

Written by the Lead at the end of a long session. Read this, then
`team/BOARD.md`, `team/RULES.md`, `team/PRODUCT.md`, `team/DECISIONS.md`,
`team/QUESTIONS.md`. Those files are the team's memory; this file only says
where things stood at the cut.

## State of the repo
- Last commit: `5599815`. Everything through **T-010** is pushed and deployed, and
  migrations **0001-0041** are applied to the live Supabase project.
- **T-039 (lineup lock) is in flight and UNCOMMITTED.** It has passed 3 review
  rounds and 1 test round; the tester's FAIL items 1 and 3 are fixed but that fix
  has not been reviewed or re-tested. Uncommitted files:
  - new: `supabase/migrations/0042_lineup_lock_enforcement.sql`,
    `src/app/l/[leagueId]/lineup-lock.tsx`,
    `src/app/l/[leagueId]/team/[teamId]/{actions.ts,lineup-override.tsx}`,
    `scripts/lineup-lock.test.ts`, `scripts/lineup-lock-edges.test.ts`
  - modified: `src/lib/{roster,lineup,types}.ts`, `my-team/{actions,editor,page}.tsx`,
    `team/[teamId]/page.tsx`, `players/page.tsx`, `trades/page.tsx`,
    `admin/{actions,settings-panel}.tsx`, `api/cron/lock-lineups/route.ts`,
    `globals.css`, `scripts/{finalize-edges.test,seed-test-league}.ts`
  - Checks last run: tsc, lint, build, db:verify clean; `npm test` 503/505 (the only
    2 failures are the known live-feed test, T-005).
  - **Not done:** a designer pass marking a dropped-but-locked player (`RosterEntry.onRoster === false`)
    with a "Dropped" pill plus one line saying his points still count this week. The
    executive interrupted that step; ask before restarting it.
  - Then: reviewer → tester → commit → push → `npm run db:push` (0042).

## Infrastructure (all working as of this handoff)
- Hosting: **Vercel**, auto-deploys from `main`. Production: https://choas-league.vercel.app
- Env vars are set in Vercel; `CRON_SECRET` was rotated and matches `.env.local` and the
  GitHub secret. The scheduled-jobs workflow defaults `APP_URL` to the production URL.
- GitHub Actions scheduled jobs pass (they had been failing silently for weeks).
- `npm run db:push` works from this machine with `SUPABASE_DB_URL` in `.env.local`.

## Demo league
- `Fake Test League`, league id **3ca78f4e-339f-463c-9e43-6acbfae610fd**, join code `33A2768D`.
- 12 teams, 2025 season played out to completion (week 17), real stat lines.
- The executive owns a team and is commissioner. Every kickoff is in the past, so every
  week is locked once 0042 ships; a league with a future kickoff is needed to show the
  unlocked path.
- Re-running `npm run seed:test-league` rebuilds it with a NEW id. Don't re-seed while
  the executive is clicking around.

## Open with the executive
- **He lost his login** (`j.don.sawyer@gmail.com`, display name CommishDburg). The app has
  no password reset, so he has to reset it in the Supabase dashboard
  (Authentication → Users), or sign up a new account and have the seed re-point the
  league with `npm run seed:test-league -- --email <new address>`. Never set his password.
- **T-060 (P0)** was queued because of that: a real forgot-password flow.
- Open questions in `team/QUESTIONS.md`: none. Q1-Q12 are answered.

## Priorities agreed with the executive
1. T-039 finish and ship
2. T-060 password reset
3. T-056 carry lineups forward week to week (locks make this urgent)
4. T-031 league privacy sweep (he asked that nobody see a league they aren't in)
5. T-040 trade review settings, T-018 desktop shell + the 1024px split, T-021 split-view pilot

## Environment notes
- The previous session had a dev server running on port 3000 (`preview_start` name `dev`,
  from `.claude/launch.json`). A new session does not inherit it: start your own if you
  need one, or expect "port in use" if the old one is still alive.
- The five agent definitions in `.claude/agents/` (engineer, reviewer, tester, designer,
  fantasy-expert) load at session start, so they are available immediately. In the previous
  session they were created mid-run and had to be invoked through a general-purpose agent
  until it restarted; that workaround is no longer needed.
- `npm test` has 2 known failures in `scripts/feeds.test.ts` (a live Sleeper feed threshold,
  queued as T-005). Treat any other failure as real.
- Windows: the Bash tool is Git Bash. Heredocs containing Python triple quotes have broken
  mid-command before; write a script into the scratchpad directory and run it instead.
  `sed -i` works. Python's default stdout encoding here is cp1252, so avoid printing
  characters like the arrow in board rows.
- Subagents cannot spawn subagents, which is why the Lead must be the main session.

## How to work (short version; `team/RULES.md` is the full set)
- You are the Lead. Subagents: `engineer`, `reviewer`, `tester`, `designer`, `fantasy-expert`.
  One task at a time, one helper at a time.
- Pipeline: engineer and/or designer → reviewer → tester → Lead commits, pushes, and runs
  `db:push` if there's a migration.
- Log every small decision in `DECISIONS.md`. Big decisions (see RULES.md) stop and go to
  `QUESTIONS.md` with options and a recommendation.
- Keep check-ins concise, minimise what the executive has to test by hand, and update
  `team/CHECKIN.md` at the end of a run.
