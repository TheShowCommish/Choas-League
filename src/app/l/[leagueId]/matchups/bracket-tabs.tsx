"use client";

import { useId, useRef, useState } from "react";

/**
 * The phone's switch between the championship bracket and the losers
 * bracket. The panels are rendered on the server and handed in whole;
 * this only decides which one is showing.
 */
export function BracketTabs({
  tabs,
  initial,
}: {
  tabs: { key: string; label: string; content: React.ReactNode }[];
  initial: string;
}) {
  const [active, setActive] = useState(initial);
  const base = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(event: React.KeyboardEvent, index: number) {
    const step =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + tabs.length) % tabs.length;
    setActive(tabs[next].key);
    buttons.current[next]?.focus();
  }

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Bracket" className="segmented">
        {tabs.map((tab, index) => {
          const selected = tab.key === active;
          return (
            <button
              key={tab.key}
              ref={(el) => {
                buttons.current[index] = el;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${tab.key}`}
              aria-selected={selected}
              aria-controls={`${base}-panel-${tab.key}`}
              tabIndex={selected ? 0 : -1}
              className="segmented-item"
              onClick={() => setActive(tab.key)}
              onKeyDown={(e) => onKeyDown(e, index)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {tabs.map((tab) => (
        <div
          key={tab.key}
          role="tabpanel"
          id={`${base}-panel-${tab.key}`}
          aria-labelledby={`${base}-tab-${tab.key}`}
          hidden={tab.key !== active}
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}
