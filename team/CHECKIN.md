# Check-in — 2026-09-16

## Needs you (1)
1. **The live site is down (500 on every page, including /login).** The login check reads the Supabase URL and key, and they aren't reaching Vercel. That's also why every scheduled job has failed since at least Sept 14.
   - Vercel → Project → Settings → Environment Variables. Add for Production, Preview and Development: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET` (copy the values from `.env.local`).
   - Then Deployments → the latest one → ⋯ → **Redeploy**. Environment variable changes only apply to new deployments.
   - GitHub → Settings → Secrets and variables → Actions: `APP_URL` = `https://choas-league.vercel.app`, `CRON_SECRET` = the same value.

## Shipped this run
- Database updated: migrations 0038–0040 applied to Supabase (finalizing, zero-point fix, losers bracket now live)
- T-006 Matchups finalize automatically; multi-week playoff rounds close only after their last week; commissioner "Finalize week" button. Also fixed: scheduled jobs had never actually run. (3ad6b8d)
- T-009 Multi-week matchups show on every page; Week/Total switcher; ties no longer show a winner (1b4f8e3)
- T-017 Phone nav: 5 icon tabs + "More" sheet (2f2d6af)
- T-007 A 0-point position override now scores zero (e.g. WR tackles = 0); projections no longer double-count base + override (eeda779)
- T-008 Losers bracket is fully configurable per league: who plays, consolation or toilet bowl, fixed or re-seeded, own rounds and start week. New desktop/mobile setup screen with a schedule preview; bracket tabs on phones. (548a348)
- Audits: settings-first (25 hard-coded league rules → tasks). Biggest finding: **lineups don't lock at kickoff** (T-039, P0, up soon)

## Decisions the team made
- Defaults, all changeable per league: fixed playoff bracket; commissioner trade review, 24h; trade deadline the week before playoffs; seeding tiebreak head-to-head, then points for
- Unconfigured losers brackets assume nothing; the commissioner must choose every option
- A losers bracket switched off mid-playoffs still finishes its games
- Desktop/mobile split at 1024px site-wide (nav + new screens currently 768px, moving in T-018)
- A player who stops scoring has his stored week score removed rather than set to 0

## Please test by hand
- On an iPhone: the bottom nav and "More" sheet (safe-area spacing can't be emulated)
- Everything else was verified by agents (361 automated tests), except screens behind login. To let agents test those, sign into the site once in the app's built-in browser.

## Up next
T-010 seeding/tiebreak settings → T-018 desktop layout (+1024px split) → T-021 split views pilot → T-039 lineup lock → T-040 trade review settings
