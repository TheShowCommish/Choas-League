# Board

Statuses: `READY` · `IN PROGRESS` · `REVIEW` · `TEST` · `BLOCKED (Q#)` · `DONE`
Only ONE task may be IN PROGRESS / REVIEW / TEST at a time.
Priority: P0 (core promise in PRODUCT.md) · P1 (parity with ESPN) · P2 (nice to have)

## Current
_none_

## Backlog
| ID | P | Task | Owner | Status | Acceptance criteria |
|----|---|------|-------|--------|---------------------|
| T-001 | P0 | Baseline health check: lint, typecheck, tests, db:verify, build. Record failures as new tasks. | tester | READY | Report of every failing check with file:line |
| T-002 | P0 | Audit the 3 core promises (variable-length playoff matchups, separate winners/losers bracket setups, position-specific scoring on any stat) against the current code and app. | fantasy-expert | READY | Each promise rated Done / Partial / Missing with gaps listed as proposed tasks |
| T-003 | P1 | Full feature gap analysis vs ESPN, Yahoo, Sleeper. | fantasy-expert | READY | Prioritized list of proposals added to Backlog by Lead |
| T-004 | P0 | Audit desktop vs mobile experience page by page; propose the approach for separate interfaces. | designer | READY | Page-by-page findings; architecture choice goes to QUESTIONS (big decision) |

## Done
| ID | Task | Commit |
|----|------|--------|
