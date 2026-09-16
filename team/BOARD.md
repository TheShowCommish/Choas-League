# Board

Statuses: `READY` · `IN PROGRESS` · `REVIEW` · `TEST` · `BLOCKED (Q#)` · `DONE`
Only ONE task may be IN PROGRESS / REVIEW / TEST at a time.
Priority: P0 (core promise in PRODUCT.md) · P1 (parity with ESPN) · P2 (nice to have)

## Current
_none_

## Backlog
| ID | P | Task | Owner | Status | Acceptance criteria |
|----|---|------|-------|--------|---------------------|
| T-006 | P0 | Finalize matchups automatically, multi-week aware. finalize_week (0012:167) is never called in prod, so standings stay 0-0 and advance_playoffs fails; it also matches week=p_week so it would close a 2-week matchup after week 1. | engineer | READY | Cron/job marks final only matchups whose last week (week+week_count-1) is complete; 2-week matchup stays open after wk1; admin Tools "Finalize week N" override; test: standings update with no manual SQL |
| T-009 | P0 | Multi-week matchups visible everywhere (league home page.tsx:23, my-team :57, matchups list, matchup detail loads only matchup.week). | engineer→designer | READY | Any matchup whose span covers the selected week is found; detail page has Wk1/Wk2/Total toggle with per-week player points; header "Week 2 of 2" |
| T-007 | P0 | A 0-point position override must mean zero (0030:113 filters points<>0 so WR override 0 falls back to base). Projections must match. | engineer | BLOCKED (Q6) | Base tackle 5 + WR override 0 → WR 0, QB 5; projections agree; regression test |
| T-008 | P0 | Real, independent losers bracket: own rounds/teams/byes/names, advances round by round, entrants (eliminated / non-playoff / both), mode (consolation vs toilet bowl); UI preview start weeks match DB (playoff-rounds.tsx:104 vs 0034:765). | engineer→designer | BLOCKED (Q7) | All config fields honored; both modes tested; preview == DB |
| T-010 | P1 | Seeding & tiebreak options per bracket: re-seed vs fixed; seeding tiebreaker; game tiebreaker (tie currently goes to home via >=). | engineer→designer | READY | Each option configurable and tested |
| T-011 | P1 | Rewards/punishments by finishing place (label + description, shown on bracket and final standings). | engineer→designer | BLOCKED (Q8) | Commissioner can attach to places; displayed; gameplay effects per Q8 |
| T-012 | P1 | Playoff setup dry-run & validation: projected bracket from current standings; block rounds past NFL wk 18; warn if rounds don't reach one champion; atomic save. | engineer→designer | READY | All four behaviours present and tested |
| T-013 | P1 | Preview a scoring change before saving: per-team season delta, flipped matchup results, top-10 player changes; confirm to apply. | engineer→designer | READY | Preview matches actual rescore result; nothing saved until confirm |
| T-014 | P1 | Custom milestone bonuses: "stat ≥ X → N pts", optionally per position; scored in recompute, shown in breakdown. | engineer→designer | READY | e.g. TE ≥8 rec +4 works; tested |
| T-015 | P2 | League median scoring (optional extra W/L vs median; standings & seeding include it; off by default). | engineer | READY | Toggle works; tests cover standings + seeding |
| T-016 | P2 | Scoring admin QoL: ESPN Std/Half/PPR presets, "Add new catalog stats" button (backfill_scoring_rules), override count in tab header. | designer | READY | All three present |
| T-003 | P1 | Full feature gap analysis vs ESPN, Yahoo, Sleeper. | fantasy-expert | READY | Prioritized list of proposals added to Backlog by Lead |
| T-005 | P2 | Fix flaky limit in scripts/feeds.test.ts:134-137 (coverage > 3000 can't be reached; pool is ~2707). Tie it to pool size. | engineer | READY | `npm test` 225/225; test still fails if mapping genuinely regresses |
| T-004 | P0 | Audit desktop vs mobile experience page by page; propose the approach for separate interfaces. | designer | READY | Page-by-page findings; architecture choice goes to QUESTIONS (big decision) |

## Done
| ID | Task | Commit |
|----|------|--------|
| T-002 | Core-promise audit — all 3 Partial; 11 tasks + 4 questions raised | (docs) |
| T-001 | Baseline health check — tsc, lint, db:verify, build clean; 224/225 tests | cd81b46 |
