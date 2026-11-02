# Chaos League — session handoff

_Written 2026-11-02. This supersedes any older HANDOFF.md. If team/BOARD.md
disagrees on task status, trust BOARD.md (it's the live board); this file is the
narrative of the most recent work._

## 0. Read this first — who you're working with

The user is **not a developer.** Do not hand them developer tasks — no editing
env files by hand, no percent-encoding, no CLI commands, no "find your region in
the dashboard." They told us plainly: _"stop treating me like a developer, I
literally do not understand any of this."_ So:

- **Do the work for them.** Use your own tools (git, the REST API, the browser)
  rather than asking them to run things.
- **Verify, don't assume.** You can check prod state over the public REST API
  (see §2) without any password.
- **Explain outcomes in plain language.** One clear next step at a time.
- The one thing only they can do is click buttons in the Supabase/Vercel web
  UIs when something genuinely requires their login — and even then, give
  numbered, no-jargon clicks, or drive their browser if offered.

## 1. Git state (exact, as of this handoff)

- **`main` @ `abe2de4`** — pushed, in sync with `origin/main`. Contains the
  getClaims performance fix (§3) and `team/PERF.md`. **Deployable as-is.**
- **`feat/notifications-watchlist` @ `ab64d7e`** — pushed to origin. Exactly
  **one commit ahead of main** (a clean fast-forward). Holds the T-072
  notifications + T-074 watchlist feature code, the migration files
  `0044_notifications.sql` / `0045_watchlist.sql`, and the entangled hunks in
  shared files (nav, layout, players, trades/actions, cron routes, lib/types).

The feature work was split onto its own branch so it couldn't deploy before its
database tables existed. **Those tables now exist (see §2), so that reason is
gone.**

## 2. Database state (VERIFIED this session)

The user ran `apply-0044-0045.sql` in the **Supabase SQL Editor**. Confirmed via
the public REST API (`GET /rest/v1/<table>?select=id&limit=1` with the anon key
→ **HTTP 200** on both):

- ✅ `public.notifications` exists (+ its indexes, RLS policies, and the
  `notify()` SECURITY DEFINER function).
- ✅ `public.player_watchlist` exists (+ index + RLS policies).

**Caveat:** these were applied _outside_ `db:push`, so the `public.schema_migrations`
history table does **not** record 0044/0045. If anyone ever runs `db:push`
later, reconcile first with `npm run db:push -- --baseline 0045` (marks
0001–0045 as applied without executing — correct, since 0001–0043 are already in
prod and 0044/0045 we just ran). Both migrations are idempotent (`if not
exists`, `drop/create policy`, `create or replace`), so an accidental re-run is
harmless.

## 3. ➡️ The #1 next action — now unblocked

**Merge `feat/notifications-watchlist` into `main` and push.** It's a
fast-forward and it's safe now that the tables exist. This makes the in-app
notification centre and the player watchlist live.

```bash
git checkout main
git merge --ff-only feat/notifications-watchlist
git push origin main
```

Then confirm the deploy is healthy (the notification bell shows in the league
nav; `/l/<id>/watchlist` loads). The user has repeatedly authorized this
("merge it all", "push it however you need to"); the only thing that was ever
holding it back was the tables.

## 4. Performance work shipped this session

Full write-up is in **`team/PERF.md`**. Headline: the slow pages are not a query
problem (the 0043 materialized-CTE fix already took the player pool from ~308s to
~180ms) — they're slow from **serial Supabase round trips multiplied by a
Vercel↔Supabase region mismatch.**

**Shipped (on `main`, `abe2de4`):** `proxy.ts` and `getLeagueContext` now verify
the session with `supabase.auth.getClaims()` instead of `auth.getUser()`. That
removes **two serial auth-server round trips from every authed page** (getClaims
verifies the JWT signature locally, no network hop, on asymmetric signing keys).
Same security; falls back to a server call on legacy symmetric keys (no
regression).

- **To fully bank it:** the project should use **asymmetric JWT signing keys**
  (Supabase → Auth → JWT Keys → _Migrate_; one click, current default). On
  symmetric keys the change is a safe no-op.

## 5. Biggest remaining performance win (easy, now that we know the region)

**F1 — align the Vercel region to Supabase.** There is **no `vercel.json`**, so
functions deploy to the default `iad1` (us-east-1). **The Supabase project is in
`us-east-2`** (read from the pooler host in `.env.local`: `aws-0-us-east-2…`).
Co-locating the functions removes the cross-region latency multiplier from every
round trip. Add:

```json
// vercel.json  (repo root)
{ "regions": ["cle1"] }
```

`cle1` is Vercel's us-east-2 (Cleveland) region = same AWS region as Supabase.
**Confirm `cle1` is available on the user's Vercel plan before relying on it**
(Hobby plans sometimes restrict region choice to a subset; if so, `iad1` is the
nearest allowed fallback). This is a safe standalone commit.

Other remaining items (detailed in PERF.md): **F3** cache the stable
`getLeagueContext` reads (`league`/`teams`/`roster_slots`) via Next 16 `use
cache` + `cacheTag`/`revalidateTag` — needs careful write-path invalidation;
**F4** fold `fetchFacingRowsByPosition`'s two serial queries into one RPC (ride
it with the next migration). **F5** (pool RPC) is already done.

## 6. `.env.local` notes (secrets — don't echo into chat)

- The user renamed the DB var to **`SUPABASE_DB_URL1`** (the **direct**
  connection — `db.<ref>.supabase.co`, IPv6-only, does **not** connect from most
  environments, including ours) and added **`SUPABASE_DB_URL2`** (the **Session
  pooler** — `aws-0-us-east-2.pooler.supabase.com:5432`, IPv4, free, this is the
  reachable one). `URL2` may still have the literal `[YOUR-PASSWORD]`
  placeholder.
- The real database password is inside `URL1`, between `postgres:` and the `@`.
  It contains characters that must be percent-encoded for a URL (`$`→`%24`,
  `/`→`%2F`, `?`→`%3F`). **You do the encoding — never ask the user to.**
- **`db:push` reads the exact name `SUPABASE_DB_URL`** (no suffix). It's not
  needed for the merge, but if a future task needs it, set `SUPABASE_DB_URL` to
  the pooler string with the real encoded password (take password from `URL1`,
  host/user from `URL2`).
- The anon key is public (`NEXT_PUBLIC_…`) and safe to use in REST checks.

## 7. Repo quirks to know

- This is a **customized Next.js 16.3.3** — middleware is `src/proxy.ts`, not
  `middleware.ts`. `AGENTS.md` warns that APIs may differ from training data;
  read `node_modules/next/dist/docs/` before using unfamiliar Next APIs.
- The team works via subagents (engineer → reviewer, etc.) orchestrated by a
  Lead; see `team/BOARD.md` for the task board and `team/QA-T066.md` for the
  executive click-through checklist (agents can't log in, so authed screens are
  verified by code + the user).
