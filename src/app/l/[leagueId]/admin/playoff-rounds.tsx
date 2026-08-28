"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { savePlayoffRounds, type AdminResult } from "./actions";

export interface PlayoffRound {
  bracket: "winners" | "losers";
  round_index: number;
  name: string;
  weeks: number;
}

/**
 * The shape of the playoffs.
 *
 * Rounds are laid end to end from the league's first playoff week, so a
 * two-week semi-final pushes the final back on its own -- there is no
 * separate "which week is the final" setting to keep in step.
 *
 * The losers bracket is optional and starts when the first round of the
 * winners bracket has been played, because that is when there are
 * losers.
 */
export function PlayoffRounds({
  leagueId,
  startWeek,
  rounds,
}: {
  leagueId: string;
  startWeek: number;
  rounds: PlayoffRound[];
}) {
  const router = useRouter();
  const [result, setResult] = useState<AdminResult>({});
  const [pending, startTransition] = useTransition();

  const [winners, setWinners] = useState<PlayoffRound[]>(() =>
    rounds
      .filter((r) => r.bracket === "winners")
      .sort((a, b) => a.round_index - b.round_index),
  );
  const [losers, setLosers] = useState<PlayoffRound[]>(() =>
    rounds
      .filter((r) => r.bracket === "losers")
      .sort((a, b) => a.round_index - b.round_index),
  );

  function save() {
    startTransition(async () => {
      const outcome = await savePlayoffRounds(leagueId, [
        ...winners.map((r, i) => ({ ...r, bracket: "winners" as const, round_index: i + 1 })),
        ...losers.map((r, i) => ({ ...r, bracket: "losers" as const, round_index: i + 1 })),
      ]);
      setResult(outcome);
      if (!outcome.error) router.refresh();
    });
  }

  return (
    <section className="card space-y-4">
      <div>
        <h3 className="h2">Playoff rounds</h3>
        <p className="muted text-sm">
          Rounds run back to back from week {startWeek}. A two-week round
          means one matchup whose score is both weeks added together.
        </p>
      </div>

      <RoundList
        bracket="winners"
        title="Winners bracket"
        startWeek={startWeek}
        rounds={winners}
        setRounds={setWinners}
        emptyHint="No rounds set, so the bracket is worked out from the number of playoff teams: one week each until somebody wins."
      />

      <RoundList
        bracket="losers"
        title="Losers bracket"
        startWeek={startWeek + winners.reduce((n, r) => n + r.weeks, 0) || startWeek}
        rounds={losers}
        setRounds={setLosers}
        emptyHint="No consolation games. Add a round and whoever loses in the winners bracket drops into it."
      />

      {result.error && <p className="error-box">{result.error}</p>}
      {result.ok && <p className="ok-box">{result.ok}</p>}

      <button className="btn btn-primary w-full" disabled={pending} onClick={save}>
        {pending ? "Saving..." : "Save playoff rounds"}
      </button>
      <p className="muted text-xs">
        Changing these does not move a bracket that has already been
        generated. Regenerate it from the Tools tab.
      </p>
    </section>
  );
}

function RoundList({
  bracket,
  title,
  startWeek,
  rounds,
  setRounds,
  emptyHint,
}: {
  bracket: "winners" | "losers";
  title: string;
  startWeek: number;
  rounds: PlayoffRound[];
  setRounds: (next: PlayoffRound[]) => void;
  emptyHint: string;
}) {
  // Which weeks each round occupies, worked out up front rather than
  // accumulated during render.
  const spans: { from: number; to: number }[] = [];
  rounds.reduce((week, round) => {
    spans.push({ from: week, to: week + round.weeks - 1 });
    return week + round.weeks;
  }, startWeek);

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold">{title}</h4>

      {rounds.length === 0 ? (
        <p className="muted text-xs">{emptyHint}</p>
      ) : (
        <ul className="space-y-2">
          {rounds.map((round, index) => {
            const { from, to } = spans[index];

            return (
              <li
                key={index}
                className="grid grid-cols-[1fr_auto_auto] items-end gap-2"
              >
                <div>
                  <label className="label" htmlFor={`${title}-name-${index}`}>
                    Round {index + 1} &middot; week{from === to ? "" : "s"}{" "}
                    {from === to ? from : `${from}-${to}`}
                  </label>
                  <input
                    id={`${title}-name-${index}`}
                    className="input"
                    placeholder="Name it, or leave blank"
                    value={round.name}
                    onChange={(e) =>
                      setRounds(
                        rounds.map((r, i) =>
                          i === index ? { ...r, name: e.target.value } : r,
                        ),
                      )
                    }
                  />
                </div>

                <div>
                  <label className="label" htmlFor={`${title}-weeks-${index}`}>
                    Weeks
                  </label>
                  <select
                    id={`${title}-weeks-${index}`}
                    className="input w-20"
                    value={round.weeks}
                    onChange={(e) =>
                      setRounds(
                        rounds.map((r, i) =>
                          i === index
                            ? { ...r, weeks: Number(e.target.value) }
                            : r,
                        ),
                      )
                    }
                  >
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                  </select>
                </div>

                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() =>
                    setRounds(rounds.filter((_, i) => i !== index))
                  }
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <button
        type="button"
        className="btn btn-sm w-full"
        onClick={() =>
          setRounds([
            ...rounds,
            {
              bracket,
              round_index: rounds.length + 1,
              name: "",
              weeks: 1,
            },
          ])
        }
      >
        Add a round
      </button>
    </div>
  );
}
