# Check-in — 2026-09-16 (team set up)

## Needs you (2)
1. Q1 Uncommitted work — how to treat the 78 changed files already in your tree? Recommend C (team reviews + tests them as T-000).
2. Q2 Push policy — when may the Lead push/deploy? Recommend C (push to a `team` branch, you merge to main).
   → reply e.g. "Q1: C, Q2: C" or edit team/QUESTIONS.md

## Shipped since last check-in
- Team set up: 5 agents in .claude/agents, Lead playbook at /team, board + logs in team/

## Decisions the team made
- Reviewer never edits code; sends exact fixes back to the author (keeps "doesn't write code" strict)
- Tester may write test files only; uses the built-in browser at desktop + mobile widths
- Lead commits per task, only that task's files; never pushes without approval
- Run cap of 5 build tasks between check-ins

## Please test by hand
Nothing

## Up next
T-001 health check → T-002 core-promise audit → T-003 ESPN/Yahoo/Sleeper gap analysis → T-004 desktop vs mobile audit
