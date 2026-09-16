import { safeColor } from "@/lib/colors";

/** Where the theme choice is kept. Shared with ThemeSwitch. */
export const THEME_STORAGE_KEY = "chaos-theme";

export type Theme = "light" | "dark" | "team";

/**
 * Applies the saved theme before the page paints.
 *
 * This has to be a blocking inline script rather than an effect: an
 * effect runs after the first paint, so a manager on the light theme
 * would get a black flash on every load. It writes the same attribute
 * the switch below writes, so the two cannot disagree.
 */
export function ThemeScript() {
  return (
    <script
      // Small, fixed, and containing no interpolated values.
      dangerouslySetInnerHTML={{
        __html: `try{var t=localStorage.getItem(${JSON.stringify(
          THEME_STORAGE_KEY,
        )});if(t==="light"||t==="dark"||t==="team"){document.documentElement.dataset.theme=t}}catch(e){}`,
      }}
    />
  );
}

/**
 * Feeds the team theme the colours it paints with.
 *
 * Emitted by the league layout on every page, whichever theme is
 * active: the variables are inert until [data-theme="team"] reads them,
 * so there is nothing to toggle and no flash when somebody switches.
 * Rendered on the server, so the colours are in the first HTML response
 * rather than arriving a frame later.
 */
export function TeamThemeVars({
  color,
  secondary,
}: {
  color: string;
  secondary: string;
}) {
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `:root{--team:${safeColor(color)};--team-2:${safeColor(
          secondary,
        )}}`,
      }}
    />
  );
}
