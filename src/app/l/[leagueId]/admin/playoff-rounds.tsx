"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { savePlayoffRounds, type AdminResult } from "./actions";

export interface PlayoffRound {
  bracket: "winners" | "losers";
  round_index: number;
  name: string;
  weeks: number;
  /** How many teams contest the round. Null = however many survived. */
  teams: number | null;
  /** How many of those, top seeds first, sit it out. */
  byes: number;
}

/**
 * The shape of the playoffs.
 *
 * Rounds are laid end to end from the league's first playoff week, so a
 * two-week semi-final pushes the final back on its own -- there is no
 * separate "which week is the final" setting to keep in step.
 *
 * Each round says how big its field is and how many of that field are on
 * a bye. Leaving the field blank keeps the old behaviour, which is that
 * everybody still standing plays. Byes always come off the top seeds,
 * and the number is adjusted by one where the field would otherwise not
 * pair off -- see settleByes below. Every round shows what it will
 * actually produce, so none of that has to be worked out by hand.
 *
 * The losers bracket is optional and starts when the first round of the
 * winners bracket has been played, because that is when there are
 * losers.
 */
export function PlayoffRounds({
  leagueId,
  startWeek,
  playoffTeams,
  rounds,
}: {
  leagueId: string;
  startWeek: number;
  playoffTeams: number;
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
        ...winners.map((r, i) => ({
          ...r,
          bracket: "winners" as const,
          round_index: i + 1,
        })),
        ...losers.map((r, i) => ({
          ...r,
          bracket: "losers" as const,
          round_index: i + 1,
        })),
      ]);
      setResult(outcome);
      if (!outcome.error) router.refresh();
    });
  }

  return (
    <section className="card space-y-4">
      <div>
        <h3 className="h2">Playoff bracket</h3>
        <p className="muted text-sm">
          Rounds run back to back from week {startWeek}. A two-week round
          means one matchup whose score is both weeks added together.
        </p>
      </div>

      <RoundList
        bracket="winners"
        title="Winners bracket"
        startWeek={startWeek}
        defaultField={playoffTeams}
        rounds={winners}
        setRounds={setWinners}
        emptyHint="No rounds set, so the bracket is worked out from the number of playoff teams: one week each until somebody wins."
      />

      <RoundList
        bracket="losers"
        title="Losers bracket"
        startWeek={startWeek + winners.reduce((n, r) => n + r.weeks, 0) || startWeek}
        defaultField={0}
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

/**
 * The byes a round will really get, mirroring playoff_round_byes in the
 * database so the preview and the bracket cannot disagree.
 *
 * The field left playing has to be even. A request that would leave it
 * odd is nudged up, because a bye promised to a top seed is worse to
 * take away than to hand out spare -- unless nudging up would put the
 * whole field on a bye and leave the round with no games at all.
 */
function settleByes(field: number, requested: number): number {
  if (field <= 1) return 0;

  const capped = Math.min(Math.max(requested, 0), field - 1);
  if ((field - capped) % 2 === 0) return capped;
  if (capped + 1 < field) return capped + 1;
  return Math.max(capped - 1, 0);
}

function RoundList({
  bracket,
  title,
  startWeek,
  defaultField,
  rounds,
  setRounds,
  emptyHint,
}: {
  bracket: "winners" | "losers";
  title: string;
  startWeek: number;
  /** The field size to suggest for a freshly added first round. */
  defaultField: number;
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

  function patch(index: number, changes: Partial<PlayoffRound>) {
    setRounds(rounds.map((r, i) => (i === index ? { ...r, ...changes } : r)));
  }

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold">{title}</h4>

      {rounds.length === 0 ? (
        <p className="muted text-xs">{emptyHint}</p>
      ) : (
        <ul className="space-y-3">
          {rounds.map((round, index) => {
            const { from, to } = spans[index];
            const field = round.teams;
            // What the round will actually look like once the bracket
            // has refused to schedule half a matchup.
            const byes = field ? settleByes(field, round.byes) : round.byes;
            const games = field ? Math.max(0, (field - byes) / 2) : null;

            return (
              <li
                key={index}
                className="space-y-2 rounded-lg border border-border p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold">
                    Round {index + 1} &middot; week{from === to ? "" : "s"}{" "}
                    {from === to ? from : `${from}-${to}`}
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() =>
                      setRounds(rounds.filter((_, i) => i !== index))
                    }
                  >
                    Remove
                  </button>
                </div>

                <div className="grid gap-2 sm:grid-cols-[1fr_5rem]">
                  <div>
                    <label className="label" htmlFor={`${title}-name-${index}`}>
                      Name
                    </label>
                    <input
                      id={`${title}-name-${index}`}
                      className="input"
                      placeholder="Name it, or leave blank"
                      value={round.name}
                      onChange={(e) => patch(index, { name: e.target.value })}
                    />
                  </div>

                  <div>
                    <label className="label" htmlFor={`${title}-weeks-${index}`}>
                      Weeks
                    </label>
                    <select
                      id={`${title}-weeks-${index}`}
                      className="input"
                      value={round.weeks}
                      onChange={(e) =>
                        patch(index, { weeks: Number(e.target.value) })
                      }
                    >
                      <option value={1}>1</option>
                      <option value={2}>2</option>
                      <option value={3}>3</option>
                      <option value={4}>4</option>
                    </select>
                  </div>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <label className="label" htmlFor={`${title}-teams-${index}`}>
                      Teams in this round
                    </label>
                    <input
                      id={`${title}-teams-${index}`}
                      className="input"
                      type="number"
                      min={2}
                      max={32}
                      placeholder="Everyone left"
                      value={round.teams ?? ""}
                      onChange={(e) =>
                        patch(index, {
                          teams: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                    />
                  </div>

                  <div>
                    <label className="label" htmlFor={`${title}-byes-${index}`}>
                      On a bye
                    </label>
                    <input
                      id={`${title}-byes-${index}`}
                      className="input"
                      type="number"
                      min={0}
                      max={31}
                      value={round.byes}
                      onChange={(e) =>
                        patch(index, { byes: Number(e.target.value) || 0 })
                      }
                    />
                  </div>
                </div>

                <p className="muted text-xs">
                  {games === null
                    ? "Everybody still standing plays, paired by seed."
                    : games === 0
                      ? "Nobody plays: every team in this round is on a bye."
                      : `${games} game${games === 1 ? "" : "s"}` +
                        (byes > 0
                          ? `, top ${byes} seed${byes === 1 ? "" : "s"} on a bye`
                          : ", no byes") +
                        (byes !== round.byes
                          ? " — one bye added so the field pairs off evenly."
                          : ".")}
                </p>
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
              // The first round starts from the league's playoff field;
              // later rounds default to whoever survived.
              teams: rounds.length === 0 && defaultField >= 2 ? defaultField : null,
              byes: 0,
            },
          ])
        }
      >
        Add a round
      </button>
    </div>
  );
}
