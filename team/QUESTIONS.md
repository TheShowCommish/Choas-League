# Questions for the Executive

Format for every question:

```
## Q<n> — <short title>            [OPEN | ANSWERED]
Blocks: T-xxx
Question: <one sentence>
Options:
  A) ... — tradeoff
  B) ... — tradeoff
Recommendation: <letter> because <one line>
Answer: <executive fills in; a letter is enough>
```

The Lead applies answers at the start of the next `/team` run and marks them ANSWERED.

---

## Q1 — What to do with the 78 files of uncommitted work            [ANSWERED]
Blocks: all build tasks (commits must not mix your in-progress work with the team's)
Question: Your working tree has large uncommitted changes (my-team settings, draft, playoffs, ingest, new tests). How should the team treat them?
Options:
  A) Commit them as-is as a "baseline" commit before the team starts — simplest; the team then reviews/tests the baseline in T-001
  B) You finish/commit them yourself first; the team waits
  C) Team treats them as unfinished work: reviewer + tester vet them as task T-000 before committing
Recommendation: C, because it gets your pending code the same review/test gate as everything else without you doing it
Answer: A — commit everything as-is and start from there

## Q2 — Push / deploy policy                                        [ANSWERED]
Blocks: nothing (commits pile up locally until answered)
Question: Pushing to main deploys to Vercel. When may the Lead push?
Options:
  A) Never without asking — you approve each push at check-in
  B) Push automatically after a task passes review + test
  C) Work on a `team` branch and push there freely; you merge to main when you're happy (Vercel preview URL for each push)
Recommendation: C, because you get a live preview to glance at without the team ever touching production
Answer: B — push automatically after testing. (Note: site is on GitHub Pages, not Vercel.)

## Q3 — Hosting: GitHub Pages can't run this app                     [OPEN]
Blocks: nothing yet (building continues; affects whether pushes actually update a live site)
Question: The app needs a server (Next.js server actions, Supabase login cookies, /api/cron routes), but GitHub Pages only serves static files. Where should the site run?
Options:
  A) Vercel free (Hobby) tier — made by the Next.js team, deploys on every push, no code changes; README already documents it
  B) Another Node host (Netlify, Render, Cloudflare) — similar, a bit more setup
  C) Stay on GitHub Pages — requires rewriting the app as static pages + Supabase called straight from the browser; large rewrite, weaker security
Recommendation: A, because it's free, zero code changes, and auto-push then genuinely updates the live site
Answer:

## Q4 — A safe database so agents can test logged-in pages           [OPEN]
Blocks: agent testing of everything behind login (leagues, lineups, draft, admin) — until answered, those land in "Please test by hand"
Question: Agents can't test logged-in pages without an account and a league, and they must not write to your real Supabase. What should they use?
Options:
  A) A second free Supabase project just for testing — you create it once (~5 min) and paste its URL/keys into a `.env.test.local`; agents seed it with `npm run seed:test-league`
  B) Local Supabase via Docker on this PC — no cloud project, but needs Docker Desktop installed
  C) Allow a clearly named test league + test accounts in the real database
Recommendation: A, because it's free, fully isolated from real league data, and needs no installs
Answer:

## Q5 — May the team apply new database migrations to the live DB?   [OPEN]
Blocks: T-006 going live (and most future features — nearly all need schema changes)
Question: Pushed code that depends on a new migration breaks the live site until `npm run db:push` runs against your real Supabase. Who runs it?
Options:
  A) Team runs `db:push` automatically right after pushing, only when review + test passed and `db:verify` is clean
  B) Team pushes code; you run `npm run db:push` yourself when you see "migration pending" in the check-in
  C) Team holds back any push that includes a migration until you approve at check-in
Recommendation: A while the site has no real in-season league data; switch to C once your league is live
Answer:

## Q6 — Should a 0-point position override mean "scores zero"?      [OPEN]
Blocks: T-007
Question: Today, setting "WR tackle = 0" is silently ignored and the WR gets the base tackle value. Fixing it changes scores for any league that already has 0-point overrides.
Options:
  A) Fix it — 0 means zero; rescore existing leagues
  B) Fix it for new rules only; leave existing leagues' stored scores untouched until the commissioner re-saves
Recommendation: A, because it's the exact example in your brief and nobody intended a 0 to mean "use the base value"
Answer:

## Q7 — Default format for the losers bracket                          [OPEN]
Blocks: T-008
Question: When a commissioner turns on a losers bracket, what should it default to? (They can change it either way.)
Options:
  A) Consolation — eliminated playoff teams play on for 3rd/5th place; winners advance
  B) Toilet bowl — non-playoff teams play; losers advance; last team standing is the league's last place
  C) Both brackets available, commissioner must pick (no default)
Recommendation: B, because it's the one people actually care about and the one ESPN lacks
Answer:

## Q8 — Should rewards/punishments change gameplay?                 [OPEN]
Blocks: T-011
Question: When the commissioner attaches a reward/punishment to a finishing place, is it just a label, or can it change the game?
Options:
  A) Display only (e.g. "Toilet Bowl loser: wears a jersey") on the bracket and standings
  B) Display + optional effects: next year's draft slot, FAAB budget bonus/penalty
Recommendation: A now, B later — labels ship quickly; effects need next-season rollover which doesn't exist yet
Answer:
