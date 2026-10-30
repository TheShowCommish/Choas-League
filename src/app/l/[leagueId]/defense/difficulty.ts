/**
 * Presentation-only (T-089): turns a defense's rank-vs-position into a
 * green -> red difficulty cue, shared by the My Team matchup card and the
 * drill-down banner so the two always read the same colour and word.
 *
 * rank 1 = allows the MOST to the position = the softest matchup = EASY
 * (green). The stingiest third of defenses is TOUGH (red); the middle
 * band is neutral. No points maths lives here -- rank and teams arrive
 * already computed from defense-vs-position.ts; this only maps them to a
 * tier and the classes that paint it.
 */
export type DifficultyTier = "easy" | "neutral" | "tough";

/**
 * Which third of the league the rank falls in, by difficulty. Below three
 * ranked defenses the split is meaningless, so it reads neutral.
 */
export function difficultyTier(rank: number, teams: number): DifficultyTier {
  if (teams < 3) return "neutral";
  const band = teams / 3;
  if (rank <= band) return "easy";
  if (rank > teams - band) return "tough";
  return "neutral";
}

/** A plain word for the tier, so colour is never the only cue. */
export const DIFFICULTY_WORD: Record<DifficultyTier, string> = {
  easy: "Soft",
  neutral: "Even",
  tough: "Tough",
};

/**
 * Chip fill for the tier -- the .pill shape in globals.css recoloured.
 * Neutral keeps the plain surface so only the two extremes draw the eye.
 */
export const DIFFICULTY_CHIP: Record<DifficultyTier, string> = {
  easy: "border-positive/40 bg-positive/10 text-positive",
  neutral: "border-border bg-surface-2 text-muted",
  tough: "border-negative/40 bg-negative/10 text-negative",
};

/** The headline number's colour on the drill-down banner. */
export const DIFFICULTY_TEXT: Record<DifficultyTier, string> = {
  easy: "text-positive",
  neutral: "text-foreground",
  tough: "text-negative",
};
