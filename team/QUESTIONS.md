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
