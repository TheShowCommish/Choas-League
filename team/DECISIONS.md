# Decisions Made by the Team

Small decisions only (see RULES.md). One line each, newest at the bottom.
The executive can reverse any of them. Mark reviewed entries with ✔ in CHECKIN.

| Date | Task | Decision | Who | Easy to reverse? |
|------|------|----------|-----|------------------|
| 2026-09-16 | Q1 | Commit all existing uncommitted work as-is as the baseline | executive | no |
| 2026-09-16 | Q2 | Auto-push to origin main after a task passes review + test | executive | yes |
| 2026-09-16 | T-001 | Test-threshold failure in feeds.test.ts treated as minor (P2 T-005), not a blocker for pushing the baseline | Lead | yes |
| 2026-09-16 | T-004 | Desktop/mobile tasks that don't depend on the architecture (nav, desktop shell, tap targets, live refresh) proceed now; split-view tasks wait on Q9 | Lead | yes |
| 2026-09-16 | T-004 | Draft-room mobile rework set to P2 (season is underway; next draft is months out) | Lead | yes |
| 2026-09-16 | T-006 | A week auto-closes only when all its games are final/postponed, every final game has official nflverse stats, and the last kickoff was 36h+ ago | engineer | yes |
| 2026-09-16 | T-006 | Stats job syncs the latest started week + the week before (from the NFL schedule), instead of league current_week | engineer | yes |
| 2026-09-16 | T-006 | Commissioner "Finalize week" refuses weeks that haven't been played; finalize_week no longer callable by anonymous users | engineer | yes |
| 2026-09-16 | T-006 | Finalized matchups keep their results when scoring rules change (pending Q10) | Lead | yes |
| 2026-09-16 | T-006 | Multi-week matchups auto-close only when every covered week is complete; auto-finalize skips leagues not in season | Lead | yes |
| 2026-09-16 | T-006 | /api/cron/* bypasses the login redirect (protected by CRON_SECRET instead); scheduled workflow now fails on any non-2xx | engineer | yes |
| 2026-09-16 | T-006 | Auto-finalize only runs for leagues in_season or playoffs | engineer | yes |
| 2026-09-16 | T-009 | Matchup lookups use a shared span helper (start week W-3..W, exact filter in code; DB caps span at 4) — no migration | engineer | yes |
| 2026-09-16 | T-009 | Matchup detail: Total is default; ?week=N shows one week; linkable; single-week matchups unchanged | engineer | yes |
| 2026-09-16 | T-009 | Multi-week lineups stacked (not side-by-side) on desktop; sticky segmented Week/Total switcher; "Week 2 of 2" accent badge | designer | yes |
| 2026-09-16 | T-009 | A tied final shows no winner anywhere | Lead | yes |
| 2026-09-16 | Q3-Q10 | Executive: hosting = Vercel; test on current DB; automate db:push; league formats are per-league settings; unique desktop (decisions) and mobile (quick actions) views; target 2027 season | executive | n/a |
| 2026-09-16 | Q9 | Architecture A: each page loads data once, renders separate Desktop and Mobile view components chosen by screen width | Lead | yes |
| 2026-09-16 | T-017 | Keep viewportFit "cover" site-wide (required for iPhone safe-area padding) | designer | yes |
| 2026-09-16 | T-017 | Phone tabs: Home, Team, Matchups, Players, More; Draft listed first in More when open; sheet is a native dialog | designer | yes |
| 2026-09-16 | T-036 | Default playoff bracket = fixed (no re-seeding), as ESPN does; reseed is a per-bracket setting | Lead | yes |
| 2026-09-16 | T-036 | Default trade review = commissioner, 24h window; deadline defaults to the week before playoffs (all per-league settings) | Lead | yes |
| 2026-09-16 | T-036 | Default seeding tiebreakers = head-to-head, then points for | Lead | yes |
| 2026-09-16 | T-007 | A player who no longer scores has his stored week score row deleted (not set to 0); blank positional points box is an error | engineer | yes |
