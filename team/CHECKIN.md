# Check-in — 2026-09-16

## Needs you (4)
1. **Database connection string** — `npm run db:push` can't reach Supabase: `SUPABASE_DB_URL` in `.env.local` is the direct connection (IPv6-only). Replace it with the **Session pooler** string (Supabase → Project Settings → Database → Connection string → Session pooler; paste your password in). Until then migration 0038 isn't applied and the finalize job/button will error.
2. **Vercel + GitHub secrets** — confirm these are set, or scheduled jobs can't run: Vercel env vars `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`; GitHub repo secrets `APP_URL` (your Vercel URL) and `CRON_SECRET` (same value).
3. Q11 Lock down who can read team points (security)? Recommend A: members only.
4. Q12 Keeper/dynasty leagues before 2027? Recommend A if any league keeps players; else B.
   → reply e.g. "Q11: A, Q12: B"

## Shipped since last check-in
- T-009 Multi-week matchups show on every page; matchup page has Week/Total switcher; ties no longer show a winner (1b4f8e3)
- T-017 Phone nav: 5 icon tabs + "More" sheet; theme and sign out moved into it (2f2d6af)
- Rules updated with your answers: Vercel, test on current DB, automated migrations, every league format is a per-league setting, desktop = decisions / mobile = quick actions, target 2027
- T-036 Settings audit: 25 hard-coded league rules found → 8 new tasks. Biggest bug: **lineups don't lock** (a manager can start a player whose game already ended) → T-039 P0

## Decisions the team made
- Desktop/mobile built as separate view components per page, chosen by screen width
- Defaults (all changeable per league): fixed playoff bracket, commissioner trade review 24h, trade deadline week before playoffs, seeding tiebreak head-to-head then points for
- Multi-week lineups stacked on desktop; phone tabs Home/Team/Matchups/Players/More

## Please test by hand
- On an iPhone: the new bottom nav and More sheet (safe-area spacing can't be emulated)

## Up next
T-007 zero-point overrides → T-008 losers bracket settings → T-010 seeding/tiebreak settings → T-018 desktop shell → T-039 lineup lock
