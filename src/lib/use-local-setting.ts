"use client";

import { useSyncExternalStore } from "react";

/**
 * A preference remembered in the browser -- the theme, whether the nav
 * menu is open -- read as if it were React state.
 *
 * localStorage is an external store, and reading one in an effect and
 * copying it into useState is the pattern useSyncExternalStore exists to
 * replace: the effect runs after the first paint, so the component
 * renders once with the wrong answer, and every consumer of the same key
 * has to be told about a change by hand.
 *
 * The server snapshot is the fallback, which is also what the markup
 * renders. React hydrates against that and then re-renders with the real
 * value, so there is no mismatch to suppress.
 *
 * Note that this only makes the *React* side agree. Anything that has to
 * be right before the first paint -- the theme, most of all -- still
 * needs a blocking script in the document; see ThemeScript.
 */

const listeners = new Set<() => void>();

/**
 * Values set this session, in case localStorage is unavailable. Private
 * browsing and a full quota both make setItem throw, and a preference
 * that silently refuses to change is worse than one that is forgotten
 * when the tab closes.
 */
const overrides = new Map<string, string>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function read<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const override = overrides.get(key);
  if (override !== undefined && (allowed as readonly string[]).includes(override)) {
    return override as T;
  }

  try {
    const stored = localStorage.getItem(key);
    if (stored !== null && (allowed as readonly string[]).includes(stored)) {
      return stored as T;
    }
  } catch {
    // No storage available. The fallback is the answer.
  }

  return fallback;
}

/**
 * The current value of one remembered setting. Re-renders every
 * component using the same key when it is written.
 *
 * `allowed` is not decoration: the value comes back from storage the
 * user's browser controls, and a stale or hand-edited entry must not be
 * able to put an unknown string into a `data-` attribute or a class
 * name.
 */
export function useLocalSetting<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  return useSyncExternalStore(
    subscribe,
    () => read(key, allowed, fallback),
    () => fallback,
  );
}

/** Writes one, and tells everybody reading it. */
export function writeLocalSetting(key: string, value: string) {
  overrides.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    // Kept for this session only.
  }
  for (const listener of listeners) listener();
}
