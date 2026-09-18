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
| 2026-09-16 | T-008 | Split-view convention: server-rendered pages render both Desktop and Mobile views and hide one with CSS; client forms pick one view with the use-wide-screen hook (avoids duplicate form ids) | designer | yes |
| 2026-09-16 | T-008 | Desktop/mobile breakpoint is lg (1024px) per Q9; nav and hook currently use md (768px) and move in T-018 | Lead | yes |
| 2026-09-16 | T-008 | Existing leagues with losers rounds map to: on, eliminated playoff teams, consolation, reseed, start week after winners round 1; all others off with no choices; enabling requires all choices. Difference: old code also made beaten semifinalists play a "Consolation" game; new model only takes losers present at the losers start week (acceptable, nothing is real yet; regenerate test brackets after db:push) | engineer | yes |
| 2026-09-16 | T-008 | Toilet bowl seeds worst record as seed 1; fallback round names "Consolation/Toilet Bowl Round N / Final" | engineer | yes |
| 2026-09-16 | T-008 | A losers bracket switched off mid-playoffs still finishes its existing games; switching off only prevents starting a new one | engineer | yes |
| 2026-09-16 | Q11/Q12 | Executive: all league data members-only (T-031 raised to P0, full audit); keeper/dynasty out of scope (T-044 removed) | executive | n/a |
| 2026-09-17 | T-010 | No "split" game tiebreak: a round must send exactly one team on, so both advancing breaks every later round's field and neither ends the bracket with nobody in it; higher_seed covers "let the draw decide" | engineer | yes |
| 2026-09-17 | T-010 | "Higher seed" compares the two teams' playoff_seeds.seed for that bracket (lower number goes through), not the home side -- a fixed draw pairs slots, so home can hold the worse seed. Home is only a fallback when a seed row is missing. A toilet bowl seeds the worst record first, so a tie sends the worse team down | engineer | yes |
| 2026-09-17 | T-010 | bench_points and points_for pick the WINNER of a tied game; the bracket then decides whether winning means advancing (in a toilet bowl the winner escapes). Level on those too and they fall back to the seed | engineer | yes |
| 2026-09-17 | T-010 | points_against seeds the MOST points against first (ESPN's reading: the hardest-shot-at team gets the edge); labelled that way in the admin UI | engineer | yes |
| 2026-09-17 | T-010 | coin_flip is deterministic: first 32 bits of md5(league, season, team), so regenerating a bracket cannot change the seeding | engineer | yes |
| 2026-09-17 | T-010 | division_record is accepted and stored but sorts as a constant until divisions exist (T-041); the admin UI says so | engineer | yes |
| 2026-09-17 | T-010 | Seeding tiebreakers are league-wide, not per bracket: both brackets are drawn from one regular-season table. Reseed and game tiebreak are per bracket | engineer | yes |
| 2026-09-17 | T-010 | An empty seeding_tiebreakers list is a real answer (wins, losses, then team id); only a null falls back to the default | engineer | yes |
| 2026-09-17 | T-010 | head_to_head counts the same games the standings view counts (regular season, final), read inside the group tied on wins and losses; a pair that never met scores 0.5 so the next tiebreaker decides | engineer | yes |
| 2026-09-17 | T-010 | "Bench" for bench_points is every rostered player not in a starting slot that week -- IR, players nobody placed, and players left in a deleted slot key included -- so the number matches benchOf on the matchup screen exactly | engineer | yes |
| 2026-09-17 | T-010 | The bracket's 'Advances' tag now comes from a new playoff_advancers_for RPC rather than from the score, because a tie is settled by the league's own tiebreak | engineer | yes |
| 2026-09-18 | T-010 | Standings page orders teams by league_seeding_order (via new members-only RPC league_standings_order), so the table and its playoff cut line match the bracket. Unconfigured leagues with distinct records read exactly as before; where records tie they now follow the logged default (head to head, then points for) instead of going straight to points for | engineer | yes |
| 2026-09-18 | T-010 | If league_standings_order returns nothing (call failed) the standings page falls back to the old wins/losses/points-for sort rather than showing a blank table | engineer | yes |
| 2026-09-18 | T-010 | Standings sort by the league's seeding order (same logic as the bracket), with a caption naming the tiebreakers; tied final playoff games show the winner with a 'Tiebreak' badge | engineer/designer | yes |
