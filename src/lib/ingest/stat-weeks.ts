/**
 * Which weeks the scheduled stat sync should pull.
 *
 * Worked out from the NFL schedule rather than from any league's
 * current_week: nothing moves current_week through the regular season,
 * so following it would pull week 1 forever and no later week would
 * ever get its official numbers -- nor, therefore, be finalized.
 *
 * The latest week that has kicked off, plus the week before it. Once
 * Thursday night starts a new week, the previous one still has its
 * Monday night game and its stat corrections to come in.
 */
export function statWeeksToSync(
  games: { week: number; kickoff_at: string | null }[],
  now: Date,
): number[] {
  let latest = 0;
  for (const game of games) {
    if (!game.kickoff_at) continue;
    if (new Date(game.kickoff_at).getTime() > now.getTime()) continue;
    latest = Math.max(latest, game.week);
  }

  if (latest === 0) return [];
  return latest > 1 ? [latest - 1, latest] : [latest];
}
