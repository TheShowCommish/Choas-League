# Efficiency deep-dive — why pages feel slow, and what fixes it

_2026-10-30. Scope: the authed pages that were reported slow (Players, My Team,
Draft). The earlier 0043 fix already took the player-pool RPC from ~308s to
~180ms, so the remaining slowness is **not query compute** — it is **network
round-trips, each multiplied by cross-region latency.**_

## TL;DR

Every authed page load is a chain of **serial** calls to Supabase. Wall-clock is
roughly `(number of serial hops) × (latency per hop)`. We attack both terms:

- **Cut the hop count** — the two biggest offenders were _auth-server_ round
  trips that don't need to touch the network at all. **Fixed now** (see F2).
- **Cut the per-hop latency** — Vercel and Supabase are almost certainly in
  different regions, so each hop pays ~60–80ms instead of ~1–5ms. **This is the
  single largest lever and it is gated on one piece of info** (F1).

## The latency stack (one league page, signed in)

```
proxy.ts            auth.getUser()                 ← auth-server RTT, every request
  └─ getLeagueContext
       auth.getUser()                              ← auth-server RTT, serial
       Promise.all(league, membership, teams, slots)  ← 1 data RTT (parallel)
  └─ page body (e.g. My Team)
       getTeamRoster()  Promise.all(5 reads)        ← 1 data RTT
       Promise.all(limits, matchups, standings, facing)
            facing = games → scores                 ← 2 serial RTTs inside
```

So a My Team load is ~**6 serial round trips** before it can render. At
in-region latency (~3ms) that's ~18ms of network — invisible. At cross-region
latency (~70ms) it's ~420ms of pure waiting, on top of Vercel cold starts. That
is exactly the "data-heavy pages are still VERY slow" symptom.

---

## Findings, ranked by impact

### F1 — Align the Vercel region to the Supabase region  ⚠️ **biggest win, gated**

There is **no `vercel.json`**, so the functions deploy to Vercel's default
(`iad1`, Washington DC). If the Supabase project is not in `us-east-1`, _every
round trip above_ crosses the country and back. This single multiplier dwarfs
every other item on this list.

**Fix** (once the Supabase region is known — the same dashboard value as the
pooler host that's been blocking `db:push`):

```json
// vercel.json
{ "regions": ["<supabase-region, e.g. iad1 / sfo1 / pdx1>"] }
```

I deliberately did **not** guess a region — a wrong guess makes it *worse*. Grab
the region from **Supabase → Project Settings → Database** (same place as the
Session pooler host) and this becomes a one-line commit.

### F2 — Verify the session locally, not at the auth server  ✅ **done, this session**

`proxy.ts` (every request) **and** `getLeagueContext` (every one of the 25
league pages) each called `supabase.auth.getUser()`, which is a network round
trip to Supabase's auth server. That's **two serial auth RTTs on every authed
page**, before any data loads.

Swapped both to `supabase.auth.getClaims()`, which verifies the JWT signature
**locally via WebCrypto — no network hop — when the project uses asymmetric
signing keys.** It still refreshes a near-expiry session (so the proxy keeps
doing its job) and the signature is still cryptographically checked, so identity
is exactly as trustworthy as before. RLS guards every query regardless.

- Changed: `src/proxy.ts`, `src/lib/league.ts`. Typecheck clean; verified the
  signed-out → `/login` redirect still works (`proxy.ts: 10ms`).
- **To actually bank it:** the project must be on **asymmetric JWT signing
  keys** — Supabase → Auth → JWT Keys → _Migrate_ (the current default; one
  click, no downtime). On legacy symmetric keys `getClaims()` falls back to a
  server call, i.e. **no regression**, just no gain until migrated.
- Not touched: the `getUser()` in write server-actions (`leagues/actions.ts`,
  `watchlist-actions.ts`) — writes are rare and the extra assurance is cheap
  there. Easy follow-up if we want uniformity.

### F3 — Cache the stable `getLeagueContext` reads  (phase 2, needs care)

`getLeagueContext` fires 4 queries on **every** page nav, but `league`,
`teams`, and `roster_slots` change rarely (rename, settings, roster config).
Next 16's `use cache` + `cacheTag`/`revalidateTag` (requires
`cacheComponents: true` in `next.config.ts`) could serve these from memory and
collapse the context batch to just the per-user membership check.

Not done now because `cacheComponents` is an app-wide mode switch and correct
`revalidateTag` wiring must cover every write path that mutates those rows
(team rename, team claim, admin settings, draft that fills rosters). Worth it,
but it's a deliberate change with its own test pass — not a drive-by.

### F4 — Collapse the `facing` read's internal 2 hops  (fold into the migration batch)

`fetchFacingRowsByPosition` does `player_game_stats` → then
`player_week_scores` (the second needs ids from the first) = 2 serial RTTs on
My Team's critical path. A single SQL RPC that joins them server-side makes it
one hop. That's a new migration, so it rides with the already-blocked `db:push`
batch (notifications, watchlist, FG scoring) rather than shipping alone.

### F5 — Player-pool RPC compute  ✅ already fixed (0043)

Noted for completeness: the ~308s → ~180ms materialized-CTE fix is in. The pool
query is no longer a compute problem; its remaining cost is the one network hop
to reach it (F1).

---

## Do-next order

1. **Give me the Supabase region** → ship `vercel.json` (F1). Biggest single win,
   same unblock as `db:push`.
2. **Migrate to asymmetric JWT keys** (F1/F2) → banks the auth-hop win already in
   the code, one click.
3. Ship the held migration batch → folds in F4 (and FG scoring, notifications,
   watchlist).
4. Phase-2: context caching (F3) with full tag-invalidation + tests.

Items 1 and 2 are both one-action dashboard changes that together likely remove
~3 serial cross-region round trips from every page.
