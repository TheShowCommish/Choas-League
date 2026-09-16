"use client";

import { useEffect } from "react";

import { useLocalSetting, writeLocalSetting } from "@/lib/use-local-setting";
import { THEME_STORAGE_KEY, type Theme } from "./theme";

const THEMES = ["light", "dark", "team"] as const;

const OPTIONS: { value: Theme; label: string; title: string }[] = [
  { value: "light", label: "Light", title: "Light theme" },
  { value: "dark", label: "Dark", title: "Dark theme" },
  { value: "team", label: "Team", title: "Your team's colours" },
];

/**
 * Light, dark, or the manager's own team colours.
 *
 * The theme lives on <html data-theme>, which is where every token in
 * globals.css is defined, so switching it is one attribute write rather
 * than a re-render of the tree. The effect is what performs that write;
 * the value it writes comes from the stored setting, so this component
 * and the boot script are never the source of two different answers.
 */
export function ThemeSwitch({
  className = "",
  size = "sm",
}: {
  className?: string;
  /** "lg" fills its row with 44px buttons, for the phone's More sheet. */
  size?: "sm" | "lg";
}) {
  const theme = useLocalSetting(THEME_STORAGE_KEY, THEMES, "dark");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <div
      className={`${size === "lg" ? "flex w-full" : "inline-flex"} overflow-hidden rounded-md border border-border ${className}`}
      role="group"
      aria-label="Theme"
    >
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          aria-pressed={theme === option.value}
          onClick={() => writeLocalSetting(THEME_STORAGE_KEY, option.value)}
          className={`${size === "lg" ? "min-h-11 flex-1 text-sm" : "min-h-9 text-xs"} px-2.5 font-medium transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
            theme === option.value
              ? "bg-accent text-accent-ink"
              : "bg-surface-2 text-muted hover:text-foreground"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
