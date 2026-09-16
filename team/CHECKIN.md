# Check-in — 2026-09-16

## Needs you (8)
1. Q3 Hosting — GitHub Pages can't run this app (needs a server). Recommend A: Vercel free tier.
2. Q5 Live DB migrations — who runs `db:push`? Recommend A: team, after tests pass. **Migration 0038 (T-006) is pushed but not applied**: until it is, the new finalize job and "Finalize week" button will error.
3. Q4 Test database for logged-in testing — Recommend A: a second free Supabase project.
4. Q6 0-point position override = zero (rescore existing leagues)? Recommend A. (blocks T-007)
5. Q7 Losers bracket default — Recommend B: toilet bowl. (blocks T-008)
6. Q8 Rewards/punishments — Recommend A: labels only for now. (blocks T-011)
7. Q9 Desktop/mobile architecture — Recommend A: one data load, two views chosen by screen width. (blocks T-021–T-024)
8. Q10 Rule changes vs finished weeks — Recommend C: finished weeks locked + "rescore finished weeks" checkbox.
   → reply e.g. "Q3: A, Q5: A, …" (details in team/QUESTIONS.md)

## Shipped since last check-in
- Baseline: all prior work committed + pushed (cd81b46)
- T-006 Matchups now finalize automatically; multi-week playoff rounds close only after their last week; commissioner "Finalize week" override (3ad6b8d)
- T-006 Fixed: scheduled jobs (stats sync, live scores) were being redirected to the login page and never ran, while GitHub showed them green. They now reach the app, and the workflow goes red on failure.
- Audits done: health check (T-001), core promises (T-002), desktop/mobile (T-004) → 25 tasks on the board

## Decisions the team made
- Week auto-closes only when all games are final, official stats are in, and 36h have passed; only for leagues in season
- Stats job syncs the latest started week + the one before (was stuck on league "current week")
- Finalized weeks keep results when scoring rules change (pending Q10)
- Desktop/mobile work that doesn't depend on Q9 proceeds now; phone draft room set low priority (season underway)

## Please test by hand (only what agents couldn't verify)
- Nothing yet. Admin → Tools → "Finalize a week" is untested while logged in (needs Q4), and only works after Q5.
- Heads-up: scheduled GitHub Actions may now show red. That's correct: they were failing silently before (see Q3).

## Up next
T-009 multi-week matchups visible everywhere → T-017 mobile bottom nav → T-018 desktop shell → T-019 tap targets → T-020 live score refresh
