# Board

Statuses: `READY` · `IN PROGRESS` · `REVIEW` · `TEST` · `BLOCKED (Q#)` · `DONE`
Only ONE task may be IN PROGRESS / REVIEW / TEST at a time.
Priority: P0 (core promise in PRODUCT.md) · P1 (parity with ESPN) · P2 (nice to have)

## Current
T-017 — IN PROGRESS (designer)

## Backlog
| ID | P | Task | Owner | Status | Acceptance criteria |
|----|---|------|-------|--------|---------------------|
| T-007 | P0 | A 0-point position override must mean zero (0030:113 filters points<>0 so WR override 0 falls back to base). Projections must match. | engineer | BLOCKED (Q6) | Base tackle 5 + WR override 0 → WR 0, QB 5; projections agree; regression test |
| T-008 | P0 | Real, independent losers bracket: own rounds/teams/byes/names, advances round by round, entrants (eliminated / non-playoff / both), mode (consolation vs toilet bowl); UI preview start weeks match DB (playoff-rounds.tsx:104 vs 0034:765). | engineer→designer | BLOCKED (Q7) | All config fields honored; both modes tested; preview == DB; league isn't marked complete while any playoff/losers game is open (else it can't auto-finalize) |
| T-010 | P1 | Seeding & tiebreak options per bracket: re-seed vs fixed; seeding tiebreaker; game tiebreaker (tie currently goes to home via >=). | engineer→designer | READY | Each option configurable and tested |
| T-011 | P1 | Rewards/punishments by finishing place (label + description, shown on bracket and final standings). | engineer→designer | BLOCKED (Q8) | Commissioner can attach to places; displayed; gameplay effects per Q8 |
| T-012 | P1 | Playoff setup dry-run & validation: projected bracket from current standings; block rounds past NFL wk 18; warn if rounds don't reach one champion; atomic save. | engineer→designer | READY | All four behaviours present and tested |
| T-013 | P1 | Preview a scoring change before saving: per-team season delta, flipped matchup results, top-10 player changes; confirm to apply. | engineer→designer | READY | Preview matches actual rescore result; nothing saved until confirm |
| T-014 | P1 | Custom milestone bonuses: "stat ≥ X → N pts", optionally per position; scored in recompute, shown in breakdown. | engineer→designer | READY | e.g. TE ≥8 rec +4 works; tested |
| T-015 | P2 | League median scoring (optional extra W/L vs median; standings & seeding include it; off by default). | engineer | READY | Toggle works; tests cover standings + seeding |
| T-016 | P2 | Scoring admin QoL: ESPN Std/Half/PPR presets, "Add new catalog stats" button (backfill_scoring_rules), override count in tab header. | designer | READY | All three present |
| T-017 | P0 | Mobile bottom nav redesign: 5 icon+label tabs (Home, Team, Matchups, Players, More→sheet with Trades, Standings, Log, Chat, Draft, Admin, theme, Sign out). | designer | IN PROGRESS | No horizontal nav scroll at 320px; every destination ≤2 taps; targets ≥44px; safe-area inset; theme/Sign out removed from phone header |
| T-018 | P0 | Desktop shell: permanent tab row at ≥lg (no collapsed Menu); table-heavy pages (Players, Standings, Team, Transactions) widen to max-w-7xl. | designer | READY | Active tab visible; keyboard focus check passes in all themes |
| T-019 | P1 | Mobile tap-target sweep: nothing <44px on phones (.btn-sm, week tabs, theme switch, pagination); desktop stays compact; replace nonexistent hover:bg-bg token. | designer | READY | Measured ≥44px at mobile preset; desktop unchanged |
| T-020 | P1 | Live data freshness: realtime/poll refresh for matchup scores, My Team points, Home, trade inbox badge. | engineer→designer | READY | Score change reaches open desktop + mobile tabs within 60s, no reload; one subscription per page |
| T-021 | P0 | Pilot separate desktop/mobile views on Standings then Home (per Q9 architecture). | designer | BLOCKED (Q9) | One data fetch; mobile standings no h-scroll at 375px; desktop adds streak/GB/playoff line; convention logged in DECISIONS |
| T-022 | P1 | My Team split: mobile tappable lineup → player sheet (Swap/Drop/Player); desktop ESPN-style roster table (Slot, Player, Opp, Status, Proj, Pts). | designer | BLOCKED (Q9) | No inline Drop on mobile; 16-man roster fits 1440×900; saving identical in both |
| T-023 | P1 | Players split: mobile card list, sticky search, position chips, Add/Bid bottom sheet; desktop full table + Add/Bid popover. | designer | BLOCKED (Q9) | No sideways scroll on mobile; Add/Bid reachable without h-scroll on both |
| T-024 | P1 | Matchup detail split with per-player stat-line breakdown (mobile sticky score + expandable rows; desktop side-by-side tables + hover). Engineer supplies per-week stat lines if missing. | engineer→designer | BLOCKED (Q9) | Every scored stat line visible on both; names not truncated <12 chars at 375px |
| T-025 | P2 | Draft room mobile: tabs (Pool/Board/Queue/Roster) with sticky clock/on-the-clock/Draft button below lg. | designer | READY | Clock visible while scrolling any tab at 375×812; draft in ≤2 taps; one realtime channel |
| T-026 | P2 | Chat polish: mobile full-height with pinned composer and no page jump; desktop chat as right-side drawer from any league page. | designer | READY | All three behaviours verified |
| T-027 | P1 | sync-stats runs syncWeekStats twice (re-reads season files incl. 18MB pbp) — risk vs 300s limit. Skip the older week when nfl_week_is_complete() is true; check ingest_runs durations. | engineer | READY | Most runs sync one week; measured durations logged in DECISIONS |
| T-028 | P1 | Cancelled NFL games stay 'scheduled' forever (syncGames only writes scheduled/final, sync.ts:676), so the week never auto-closes. Mark long-past unscored games postponed/cancelled. | engineer | READY | A game 7+ days past kickoff with no score doesn't block week completion; test |
| T-029 | P1 | generate_schedule (0013) deletes all regular-season matchups including final ones; regenerating mid-season wipes results. Protect finalized matchups or refuse. | engineer | READY | Regenerating never deletes a final matchup; commissioner sees why; test |
| T-030 | P2 | Cron secret compare is plain !== (src/lib/ingest/cron-auth.ts:26); use SHA-256 digests + crypto.timingSafeEqual. | engineer | READY | Timing-safe compare; 401/503 behaviour unchanged; test |
| T-031 | P1 | team_points_over (0032:99-126) is SECURITY DEFINER with no league-membership check; any signed-in user can read any team's points. Add membership check. | engineer | BLOCKED (Q11) | Non-member gets permission error; members and commissioner unaffected; test |
| T-032 | P2 | After a rescore, a final multi-week matchup's stored total can differ from the live per-week columns on matchup detail. Make per-week columns consistent with the stored final (or label them). Also: BoxScore (matchups/[matchupId]/page.tsx:341,349) should use matchupWinner instead of inline compare (disagrees with header on a final bye). | engineer | READY | Weeks always sum to the displayed Total, or a clear note explains the difference; test |
| T-033 | P1 | Login redirect drops the query string: src/proxy.ts:47 builds `next` from pathname only, so shared links like /matchups/Y?week=16 land on the wrong view after sign-in. | engineer | READY | next= preserves path + query; open-redirect safe (same-origin only); test |
| T-034 | P2 | Matchup detail polish: single-week view of a final matchup shouldn't read "FINAL" over that week's points; when per-week points fail keep switcher/body consistent with the TOTAL header; "← Week N" back link should return to the week you came from. | engineer→designer | READY | All three behaviours verified |
| T-003 | P1 | Full feature gap analysis vs ESPN, Yahoo, Sleeper. | fantasy-expert | READY | Prioritized list of proposals added to Backlog by Lead |
| T-005 | P2 | Fix flaky limit in scripts/feeds.test.ts:134-137 (coverage > 3000 can't be reached; pool is ~2707). Tie it to pool size. | engineer | READY | `npm test` 225/225; test still fails if mapping genuinely regresses |

## Done
| ID | Task | Commit |
|----|------|--------|
| T-009 | Multi-week matchups found on every page; matchup detail Week/Total switcher, per-week box score; ties show no winner | (this commit) |
| T-006 | Matchups finalize automatically (multi-week aware, in-season leagues, official stats + 36h); commissioner override; cron jobs no longer blocked by login redirect | 3ad6b8d |
| T-004 | Desktop/mobile audit — app is one responsive layout; 10 tasks + Q9 raised | (docs) |
| T-002 | Core-promise audit — all 3 Partial; 11 tasks + 4 questions raised | (docs) |
| T-001 | Baseline health check — tsc, lint, db:verify, build clean; 224/225 tests | cd81b46 |
