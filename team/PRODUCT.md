# Chaos League — Product Brief (from the executive)

Every agent reads this before starting work. It is the source of truth for
*what* we are building. Only the executive changes it.

## Goal
A fully functional fantasy football site that gives our league full control of
every feature. Most users come from **ESPN**; also adopt the well-received
features of **Sleeper** and **Yahoo**.

## Why we built our own (non-negotiable features)
1. **Full control of playoff brackets.** Matchups can last a varying number of
   weeks (e.g. a 2-week semifinal, 1-week final).
2. **Winners and losers brackets configured independently** (different sizes,
   round lengths, seeding, rewards/punishments).
3. **Score on anything.** Rules can be position-specific (a QB tackle scores,
   a WR tackle does not). The more obscure the stat, the better.

## Multi-league, settings-first (executive, 2026-09-16)
The site hosts **many leagues, each with its own rules**. Never hard-code a
league format. Anything a league could reasonably do differently (bracket
formats, losers-bracket mode, rewards/punishments, whether rule changes rescore
finished weeks, tiebreakers, median scoring...) is a **per-league commissioner
setting**. Where a default is unavoidable, pick the least surprising one and log it.

## Platforms
Full **desktop** and full **mobile** experiences. Same data at all times, but
**unique views, optimized differently**:
- **Desktop = decision making.** Deep stats, comparisons, research, trade
  analysis, lineup decisions with full context, commissioner setup.
- **Mobile = quick actions.** Fewer statistics; set lineup, check score, accept
  a trade, claim a player, chat, in as few taps as possible.

## Scope and privacy (executive, 2026-09-16)
- **Redraft leagues only.** Keeper and dynasty leagues are out of scope.
- **League data is private.** A user can only see leagues they belong to; nothing about another league is readable, in the UI or the database.

## Timeline
Nothing is live yet. Goal: **ready for real leagues by the 2027 season.**

## How the executive wants to work
- Check-ins are **concise**: improvements listed briefly, questions asked clearly.
- **Minimize what the executive has to test.** The team verifies its own work.
- Small design/function decisions: the team decides, but logs every one.
- Big decisions: stop and wait for the executive (see `team/RULES.md`).
- Automate as much as possible; only involve the executive when truly needed.
