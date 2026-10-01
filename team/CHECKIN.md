# Check-in - 2026-10-01

Session handed off. Read **team/HANDOFF.md** first: it records the state of the
in-flight T-039 work, the live demo league, the executive's lost login, and the
agreed priority order.

## Needs you (1)
1. Your login: reset it in the Supabase dashboard (Authentication > Users,
   j.don.sawyer@gmail.com), or sign up a new account and the team will re-point the
   demo league to it. A real forgot-password flow is queued as T-060 (P0).

## Demo
https://choas-league.vercel.app/l/3ca78f4e-339f-463c-9e43-6acbfae610fd

## Shipped so far
- T-006 automatic week finalizing (multi-week aware) + the fix that made scheduled jobs actually run
- T-009 multi-week matchups everywhere, Week/Total switcher
- T-017 phone bottom nav (5 tabs + More sheet)
- T-007 a 0-point position override really scores zero
- T-008 fully configurable losers bracket
- T-010 per-league seeding and playoff tiebreak settings
- Infrastructure: Vercel env vars, rotated CRON_SECRET, scheduled jobs green, migrations 0001-0041 applied

## In flight
- T-039 lineup lock: engineer fix done, uncommitted. Needs the designer 'Dropped' marker (the executive paused it), then reviewer, then tester, then push + db:push 0042.

## Up next
T-039 -> T-060 password reset -> T-056 carry lineups forward -> T-031 privacy sweep -> T-040 trade settings -> T-018 desktop shell
