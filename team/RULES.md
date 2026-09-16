# Team Rules

## Roster
| # | Agent | Role | Writes code? |
|---|-------|------|--------------|
| 1 | Lead (main session, `/team`) | Picks the next task, assigns it, tracks it, reports to the executive | No |
| 2 | `engineer` | Builds features and logic as specified. Doesn't come up with ideas or push back | Yes (not styling) |
| 3 | `reviewer` | Senior review. Every change passes review before it's committed | No (hands fixes back to engineer/designer) |
| 4 | `tester` | Hunts for bugs against what the task was meant to do | Test files only |
| 5 | `fantasy-expert` | Compares the site to ESPN/Yahoo/Sleeper and proposes work | No |
| 6 | `designer` | Owns all UI/UX, desktop and mobile | Yes (presentation only) |

## One task at a time
Only one task is `IN PROGRESS` on `team/BOARD.md` at any moment. Agents are idle
until the Lead calls them, and each returns a completion report to the Lead.

## Task pipeline
```
fantasy-expert (ideas) ─► Lead (prioritize onto BOARD)
                              │
            ┌─────────────────┴──────────────┐
      logic/data work                    UI work
        engineer                          designer
            └────────► reviewer ◄────────────┘
                  (changes requested → back to author, max 2 rounds)
                          │ approved
                        tester
                  (bugs found → back to author → reviewer → tester)
                          │ pass
                  Lead commits, logs, next task
```
Features that need both logic and UI: engineer builds working, plainly
styled pieces first; designer then does the interface; one review and test pass
covers both.

## Big decisions — STOP and ask the executive
Add to `team/QUESTIONS.md`, mark the task `BLOCKED`, move on to unblocked work.
- Changing hosting/deployment setup (Vercel, auto-deploys from `main`)
- Anything that needs the executive's accounts or secrets (Vercel, Supabase, GitHub settings)
- Hard-coding a league format instead of making it a per-league setting
- Removing or substantially redefining a feature the executive asked for
- Auth, permissions/RLS model, or security posture changes
- New paid services, new third-party data sources, or anything that costs money
- Overall architecture (e.g. how desktop and mobile are split), new frameworks
- Anything that contradicts `team/PRODUCT.md`
- Anything irreversible or anything sent to real users

## Pushing and database
After a task passes review AND test, the Lead commits and pushes to `origin main` (Vercel deploys it).
If the task added a migration, the Lead then runs `npm run db:push` (executive: automate DB updates).
Never force-push. If a push or db:push fails, record it in CHECKIN and keep working on tasks that don't depend on it.

## Test data
Nothing is real yet (target: 2027 season). Agents may use the current Supabase project for testing:
seed test leagues (`npm run seed:test-league`), create, alter and delete test data. Agents never type passwords into a browser;
for logged-in browser checks, reuse a session the executive signed into in the built-in browser.

## Small decisions — the team decides and logs them
One line each in `team/DECISIONS.md`: layout, copy, naming, component structure,
default values, ordering within the backlog, test approach, small dev-only
dependencies. If in doubt whether it's big: it's big.

## Engineering ground rules
- This is Next.js 16 — read `node_modules/next/dist/docs/` before using a Next API (see AGENTS.md).
- Verification commands: `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run db:verify` (in-memory Postgres, safe), `npm run build`.
- Never read or print secrets from `.env.local`. Only the Lead runs `db:push`.
- New migrations go in `supabase/migrations/NNNN_name.sql`, numbered after the last one.
