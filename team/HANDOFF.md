# Chaos League — session handoff

_Updated 2026-11-02 (after the merge). Supersedes any older HANDOFF.md. If
team/BOARD.md disagrees on task status, trust BOARD.md (it's the live board);
this file is the narrative of the most recent work._

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

- **`main` @ `6bebb01`** — pushed, in sync with `origin/main`, working tree
  clean. Recent commits (newest first):
  - `6bebb01` Perf: pin Vercel functions to `cle1` (us-east-2) — the region fix.
  - `14bbc3b` docs: the previous version of this handoff.
  - `ab64d7e` T-072/T-074 notifications + watchlist (the merged feature work).
  - `abe2de4` Perf: getClaims instead of per-request auth-server hop.
- **`feat/notifications-watchlist`** — fully merged into `main` (was a clean
  fast-forward). The branch still exists locally and on origin; it can be
  deleted whenever, nothing depends on it.

Everything that was in flight is now on `main`. Nothing is held back.

## 2. Database state (VERIFIED this session)

The user ran `apply-0044-0045.sql` in the **Supabase SQL Editor**. Confirmed via
the public REST API (`GET /rest/v1/<table>?select=id&limit=1` with the anon key
→ **HTTP 200** on both):

- ✅ `public.notifications` exists (+ indexes, RLS policies, `notify()` function).
- ✅ `public.player_watchlist` exists (+ index + RLS policies).

**Caveat:** applied _outside_ `db:push`, so `public.schema_migrations` does
**not** record 0044/0045. If anyone runs `db:push` later, reconcile first with
`npm run db:push -- --baseline 0045`. Both migrations are idempotent, so an
accidental re-run is harmless.

## 3. What is DONE vs OPEN

**Done & live on `main` (deploying / deployed):**

- ✅ Notifications centre + bell (T-072) and player watchlist + stars (T-074) —
  merged, and the DB tables they need exist, so they function.
- ✅ getClaims performance fix (removes 2 serial auth-server round trips/page).
- ✅ Vercel region pinned to `cle1` to co-locate with Supabase (us-east-2).

**Open items (none are blocking; do NOT start work unless the user asks):**

1. **Confirm the Vercel deploy succeeded.** The region pin assumes the user's
   Vercel plan allows `cle1` (single-region is normally allowed on every plan,
   so this is low risk, but unverified from here). If the deploy errors on the
   region, revert just `6bebb01` (`git revert 6bebb01` + push) — it's isolated
   on purpose; notifications/watchlist stay live.
2. **(Optional) Asymmetric JWT keys.** To fully bank the getClaims fix, the
   project should migrate to asymmetric JWT signing keys (Supabase → Auth → JWT
   Keys → _Migrate_, one click). On legacy symmetric keys the fix is a safe
   no-op — nothing breaks either way.

## 4. Performance deep-dive — where the remaining wins are

Full write-up: **`team/PERF.md`**. The slow pages are not a query problem (0043's
materialized-CTE fix already took the player pool from ~308s to ~180ms) — they
were slow from serial Supabase round trips × a Vercel↔Supabase region mismatch.
Two of the three top levers are now shipped (getClaims, region pin).

Still available if the user wants more speed work later:

- **F3** — cache the stable `getLeagueContext` reads (`league`/`teams`/
  `roster_slots`) via Next 16 `use cache` + `cacheTag`/`revalidateTag`. Needs
  careful write-path invalidation + its own test pass; not a drive-by.
- **F4** — fold `fetchFacingRowsByPosition`'s two serial queries into one SQL
  RPC (removes a round trip from My Team). New migration — ride it with the next
  one. Remember the `--baseline` note in §2 if `db:push` is still bypassed.
- **F5** — player-pool RPC: already fixed (0043). Nothing to do.

## 5. `.env.local` notes (secrets — don't echo into chat)

- The user renamed the DB var to **`SUPABASE_DB_URL1`** (the **direct**
  connection — IPv6-only, does **not** connect from most environments) and added
  **`SUPABASE_DB_URL2`** (the **Session pooler** —
  `aws-0-us-east-2.pooler.supabase.com:5432`, IPv4, free, the reachable one).
  `URL2` may still have the literal `[YOUR-PASSWORD]` placeholder.
- The real DB password is inside `URL1`, between `postgres:` and the `@`. It has
  characters that must be percent-encoded for a URL (`$`→`%24`, `/`→`%2F`,
  `?`→`%3F`). **You do the encoding — never ask the user to.**
- **`db:push` reads the exact name `SUPABASE_DB_URL`** (no suffix). Not needed
  for anything open above; if a future task needs it, set `SUPABASE_DB_URL` to
  the pooler string with the real encoded password.
- The anon key is public (`NEXT_PUBLIC_…`) and safe to use in REST checks.

## 6. Repo quirks to know

- Customized **Next.js 16.3.3** — middleware is `src/proxy.ts`, not
  `middleware.ts`. `AGENTS.md` warns APIs may differ from training data; read
  `node_modules/next/dist/docs/` before using unfamiliar Next APIs.
- The team works via subagents (engineer → reviewer, etc.) led by a Lead; see
  `team/BOARD.md` for the task board and `team/QA-T066.md` for the executive
  click-through checklist (agents can't log in, so authed screens are verified
  by code + the user).
