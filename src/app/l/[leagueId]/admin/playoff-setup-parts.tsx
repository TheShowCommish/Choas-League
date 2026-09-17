"use client";

import { Fragment, useId } from "react";
import {
  NFL_LAST_WEEK,
  settleByes,
  type LosersEntrants,
  type LosersMode,
  type LosersReseed,
  type RoundShape,
} from "@/lib/playoff-bracket";
import type { PlayoffRound } from "./playoff-rounds";

/*
 * The pieces the desktop and phone views of the playoff setup are built
 * from. Both views render the same pieces; they differ in how they lay
 * them out.
 */

// Copy ---------------------------------------------------------------------

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  hint: string;
}

export const ENTRANT_OPTIONS: ChoiceOption<LosersEntrants>[] = [
  {
    value: "non_playoff_teams",
    label: "Teams that missed the playoffs",
    hint: "Everyone who didn't make the championship bracket.",
  },
  {
    value: "eliminated_playoff_teams",
    label: "Teams knocked out of the playoffs",
    hint: "Playoff teams already eliminated by the losers bracket's first week.",
  },
  {
    value: "both",
    label: "Both",
    hint: "Non-playoff teams plus playoff teams already knocked out by its first week.",
  },
];

export const MODE_OPTIONS: ChoiceOption<LosersMode>[] = [
  {
    value: "consolation",
    label: "Consolation: winners advance",
    hint: "Winners keep playing; the last team standing is the best of the rest.",
  },
  {
    value: "toilet_bowl",
    label: "Toilet bowl: losers advance",
    hint: "Losers keep playing; the last team standing finishes last.",
  },
];

export const RESEED_OPTIONS: ChoiceOption<LosersReseed>[] = [
  {
    value: "fixed",
    label: "Fixed bracket",
    hint: "Teams keep their place in the draw from round to round.",
  },
  {
    value: "reseed",
    label: "Re-seed every round",
    hint: "After each round, the best seed left plays the worst.",
  },
];

/** What the bracket is called once its mode is known. */
export function losersTitle(mode: LosersMode | null): string {
  return mode === "toilet_bowl"
    ? "Toilet bowl"
    : mode === "consolation"
      ? "Consolation bracket"
      : "Losers bracket";
}

/**
 * The name a round gets when the commissioner leaves it blank, so the
 * name box can show it as a placeholder. Mirrors playoff_round_name and
 * losers_round_name in the migrations.
 */
export function defaultRoundName(
  bracket: "winners" | "losers",
  mode: LosersMode | null,
  index: number,
  shape: Pick<RoundShape, "field" | "byes"> | undefined,
): string {
  if (bracket === "winners") {
    if (!shape) return `Round ${index}`;
    const playing = shape.field - shape.byes;
    if (playing <= 2) return "Championship";
    if (playing <= 4) return "Semifinal";
    if (playing <= 8) return "Quarterfinal";
    return `Round of ${playing}`;
  }
  const prefix =
    mode === "toilet_bowl"
      ? "Toilet Bowl"
      : mode === "consolation"
        ? "Consolation"
        : "Losers";
  if (shape && shape.field - shape.byes === 2 && shape.byes === 0) {
    return `${prefix} Final`;
  }
  return `${prefix} Round ${index}`;
}

export function weekSpanLabel(from: number, to: number): string {
  return from === to ? `Week ${from}` : `Weeks ${from}–${to}`;
}

// Problems -----------------------------------------------------------------

export type ProblemTarget =
  | "entrants"
  | "mode"
  | "reseed"
  | "startWeek"
  | "rounds"
  | { round: number };

export interface Problem {
  text: string;
  target: ProblemTarget;
}

/**
 * Works out which field each validation message is about, so it can be
 * shown next to that field as well as in the summary by Save.
 *
 * validateLosersBracket returns sentences rather than codes, so this
 * reads them. Anything it doesn't recognise lands on the round list,
 * which is still visible and still listed in the summary.
 */
export function placeProblems(messages: string[]): Problem[] {
  return messages.map((text) => {
    const round = /^Round (\d+) /.exec(text);
    if (round) return { text, target: { round: Number(round[1]) } };
    if (/^Choose who enters|^Only \d+ team/.test(text)) {
      return { text, target: "entrants" };
    }
    if (/^Choose whether winners/.test(text)) return { text, target: "mode" };
    if (/^Choose a fixed/.test(text)) return { text, target: "reseed" };
    if (
      /^Choose the week|can't start before|in the middle of winners round/.test(
        text,
      )
    ) {
      return { text, target: "startWeek" };
    }
    return { text, target: "rounds" };
  });
}

export function problemsFor(
  problems: Problem[],
  target: ProblemTarget,
): Problem[] {
  return problems.filter((p) =>
    typeof target === "string"
      ? p.target === target
      : typeof p.target === "object" && p.target.round === target.round,
  );
}

/** The element a summary link jumps to. */
export function problemAnchor(target: ProblemTarget): string {
  return typeof target === "string"
    ? `losers-${target}`
    : `losers-round-${target.round}`;
}

export function FieldErrors({
  id,
  problems,
}: {
  id?: string;
  problems: Problem[];
}) {
  if (problems.length === 0) return null;
  return (
    <div id={id} className="space-y-0.5">
      {problems.map((p) => (
        <p key={p.text} className="field-error">
          <span aria-hidden>!</span>
          <span>{p.text}</span>
        </p>
      ))}
    </div>
  );
}

// Radio groups -------------------------------------------------------------

export function ChoiceGroup<T extends string>({
  id,
  name,
  legend,
  options,
  value,
  onChange,
  problems,
  columns = false,
}: {
  id: string;
  name: string;
  legend: string;
  options: ChoiceOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  problems: Problem[];
  /** Lay the options side by side where there's room. */
  columns?: boolean;
}) {
  const errorId = `${id}-errors`;
  // Nothing picked yet is not an error to shout about: the "Choose one"
  // badge says it, and the summary by Save lists it.
  const shown = value === null ? [] : problems;
  const invalid = shown.length > 0;

  return (
    <fieldset
      id={id}
      className="choice-group scroll-mt-24 space-y-2"
      aria-invalid={invalid || undefined}
      aria-describedby={invalid ? errorId : undefined}
    >
      <legend className="mb-2 flex w-full items-center justify-between gap-2 text-sm font-semibold">
        {legend}
        {value === null && <span className="badge-todo">Choose one</span>}
      </legend>
      <div className={columns ? "grid gap-2 sm:grid-cols-2" : "grid gap-2"}>
        {options.map((option) => (
          <label key={option.value} className="choice">
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            <span className="min-w-0">
              <span className="block font-medium">{option.label}</span>
              <span className="block text-xs text-muted">{option.hint}</span>
            </span>
          </label>
        ))}
      </div>
      <FieldErrors id={errorId} problems={shown} />
    </fieldset>
  );
}

// Round editor -------------------------------------------------------------

/**
 * One bracket's rounds, each editable in place.
 *
 * `shapes` is what the bracket will actually do in each configured round
 * (field, byes, weeks), used for the week label, the default name and
 * the one-line outcome.
 */
export function RoundEditor({
  bracket,
  mode,
  startWeek,
  rounds,
  setRounds,
  shapes,
  spans,
  defaultField,
  problems,
  emptyHint,
}: {
  bracket: "winners" | "losers";
  mode: LosersMode | null;
  startWeek: number;
  rounds: PlayoffRound[];
  setRounds: (next: PlayoffRound[]) => void;
  shapes: (RoundShape | undefined)[];
  spans: { from: number; to: number }[];
  /** The field size to suggest for a freshly added first round. */
  defaultField: number;
  /** Only the losers bracket has problems to place. */
  problems: Problem[];
  emptyHint: string;
}) {
  const prefix = `${bracket}-round`;
  const listProblems = problemsFor(problems, "rounds");

  function patch(index: number, changes: Partial<PlayoffRound>) {
    setRounds(rounds.map((r, i) => (i === index ? { ...r, ...changes } : r)));
  }

  return (
    <div
      id={bracket === "losers" ? "losers-rounds" : undefined}
      className="scroll-mt-24 space-y-3"
    >
      {rounds.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted">
          {emptyHint}
        </p>
      ) : (
        <ol className="space-y-3">
          {rounds.map((round, index) => {
            const number = index + 1;
            const { from, to } = spans[index] ?? { from: startWeek, to: startWeek };
            const shape = shapes[index];
            const roundProblems =
              bracket === "losers" ? problemsFor(problems, { round: number }) : [];
            const invalid = roundProblems.length > 0;
            const errorId = `${prefix}-${number}-errors`;
            const pastSeason = to > NFL_LAST_WEEK;

            // What the round will look like once the bracket has refused
            // to schedule half a matchup.
            // The worked-out shape knows about automatic first-round byes
            // and trimmed fields; without one, settle the byes here.
            const field = shape?.field ?? round.teams ?? null;
            const byes = shape
              ? shape.byes
              : field
                ? settleByes(field, round.byes)
                : round.byes;
            const games = field ? Math.max(0, (field - byes) / 2) : null;
            const adjusted = field !== null && byes !== round.byes;

            return (
              <li
                key={index}
                id={bracket === "losers" ? `losers-round-${number}` : undefined}
                className={`scroll-mt-24 space-y-3 rounded-lg border p-3 ${
                  invalid ? "border-negative/60" : "border-border"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">Round {number}</span>
                  <span
                    className={
                      pastSeason
                        ? "badge-weeks border-negative/40 bg-negative/10 text-negative"
                        : to > from
                          ? "badge-weeks"
                          : "pill"
                    }
                    title={pastSeason ? `Past week ${NFL_LAST_WEEK}` : undefined}
                  >
                    {weekSpanLabel(from, to)}
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm ml-auto min-h-11 text-negative md:min-h-9"
                    aria-label={`Remove round ${number}`}
                    onClick={() => setRounds(rounds.filter((_, i) => i !== index))}
                  >
                    Remove
                  </button>
                </div>

                <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                  <div>
                    <label className="label" htmlFor={`${prefix}-${number}-name`}>
                      Name
                    </label>
                    <input
                      id={`${prefix}-${number}-name`}
                      className="input"
                      placeholder={defaultRoundName(bracket, mode, number, shape)}
                      value={round.name}
                      onChange={(e) => patch(index, { name: e.target.value })}
                    />
                  </div>

                  <WeeksPicker
                    name={`${prefix}-${number}-weeks`}
                    value={round.weeks}
                    onChange={(weeks) => patch(index, { weeks })}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label" htmlFor={`${prefix}-${number}-teams`}>
                      Teams in round
                    </label>
                    <input
                      id={`${prefix}-${number}-teams`}
                      className="input"
                      type="number"
                      inputMode="numeric"
                      min={2}
                      max={32}
                      placeholder={index === 0 ? "All entrants" : "Everyone left"}
                      value={round.teams ?? ""}
                      aria-invalid={invalid || undefined}
                      aria-describedby={invalid ? errorId : undefined}
                      onChange={(e) =>
                        patch(index, {
                          teams: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                    />
                  </div>

                  <div>
                    <label className="label" htmlFor={`${prefix}-${number}-byes`}>
                      Byes (top seeds)
                    </label>
                    <input
                      id={`${prefix}-${number}-byes`}
                      className="input"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={31}
                      value={round.byes}
                      onChange={(e) =>
                        patch(index, { byes: Number(e.target.value) || 0 })
                      }
                    />
                  </div>
                </div>

                <p className="text-xs text-muted">
                  {outcomeText({ bracket, mode, field, byes, games, adjusted })}
                </p>

                <FieldErrors id={errorId} problems={roundProblems} />
              </li>
            );
          })}
        </ol>
      )}

      <FieldErrors problems={listProblems} />

      <button
        type="button"
        className="btn w-full md:min-h-9"
        onClick={() =>
          setRounds([
            ...rounds,
            {
              bracket,
              round_index: rounds.length + 1,
              name: "",
              weeks: 1,
              // The first round starts from the bracket's field; later
              // rounds default to whoever survived.
              teams: rounds.length === 0 && defaultField >= 2 ? defaultField : null,
              byes: 0,
            },
          ])
        }
      >
        + Add round {rounds.length + 1}
      </button>
    </div>
  );
}

/** The one line under a round saying what it will actually produce. */
function outcomeText({
  bracket,
  mode,
  field,
  byes,
  games,
  adjusted,
}: {
  bracket: "winners" | "losers";
  mode: LosersMode | null;
  field: number | null;
  byes: number;
  games: number | null;
  adjusted: boolean;
}): string {
  if (field === null || games === null) {
    return "Everybody still standing plays, paired by seed.";
  }
  if (games === 0) return "Nobody plays: every team in this round is on a bye.";

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const losersGo = bracket === "losers" && mode === "toilet_bowl";
  const through = games + byes;

  let result: string;
  if (through === 1) {
    result =
      bracket === "winners"
        ? "the winner is champion"
        : losersGo
          ? "the loser finishes last"
          : mode === "consolation"
            ? "the winner finishes best of the rest"
            : "one team left";
  } else {
    const who = `the ${games === 1 ? "loser" : "losers"}${byes > 0 ? " and byes" : ""}`;
    result = `${through} go through${losersGo ? ` (${who})` : ""}`;
  }

  return (
    `${field} teams: ${plural(games, "game")}` +
    (byes > 0 ? `, top ${plural(byes, "seed")} on a bye` : ", no byes") +
    ` → ${result}` +
    (adjusted ? `. Byes set to ${byes} so the field pairs off evenly.` : ".")
  );
}

/** 1-4 weeks as a segmented control: every option visible, one tap. */
function WeeksPicker({
  name,
  value,
  onChange,
}: {
  name: string;
  value: number;
  onChange: (weeks: number) => void;
}) {
  return (
    <fieldset>
      <legend className="label">Weeks</legend>
      <div className="segmented md:w-full">
        {[1, 2, 3, 4].map((weeks) => (
          <label key={weeks} className="segmented-item cursor-pointer md:px-3">
            <input
              type="radio"
              className="sr-only"
              name={name}
              value={weeks}
              checked={value === weeks}
              onChange={() => onChange(weeks)}
            />
            {weeks}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// Timeline -----------------------------------------------------------------

export interface TimelineRound {
  key: string;
  name: string;
  from: number;
  to: number;
  /** Worked out by the bracket rather than set by the commissioner. */
  automatic: boolean;
  /** Has a validation problem of its own (past week 18 is spotted here). */
  flagged?: boolean;
  detail: string;
}

export interface TimelineRow {
  bracket: "winners" | "losers";
  title: string;
  rounds: TimelineRound[];
  /** Shown in place of rounds when there are none. */
  emptyText: string;
}

function weekRange(rows: TimelineRow[]): number[] {
  const all = rows.flatMap((r) => r.rounds);
  if (all.length === 0) return [];
  const first = Math.min(...all.map((r) => r.from));
  const last = Math.max(...all.map((r) => r.to), first + 2);
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

/** Weeks in which both brackets have a round going on. */
function sharedWeeks(rows: TimelineRow[]): number[] {
  if (rows.length < 2) return [];
  const covers = (row: TimelineRow, week: number) =>
    row.rounds.some((r) => r.from <= week && week <= r.to);
  return weekRange(rows).filter((w) => rows.every((row) => covers(row, w)));
}

function barClass(row: TimelineRow, round: TimelineRound): string {
  const past = round.to > NFL_LAST_WEEK || round.flagged;
  const tone = past
    ? "border-negative/70 bg-negative/10"
    : row.bracket === "winners"
      ? "border-accent/50 bg-accent/15"
      : "border-muted/50 bg-muted/15";
  return `min-w-0 rounded-md border px-2 py-1.5 ${tone} ${
    round.automatic ? "border-dashed" : ""
  }`;
}

function RoundBar({ row, round }: { row: TimelineRow; round: TimelineRound }) {
  return (
    <div
      className={`${barClass(row, round)} h-full`}
      title={`${round.name}: ${round.detail}`}
    >
      <p className="truncate text-xs font-semibold">{round.name}</p>
      <p className="truncate text-[11px] text-muted tabular-nums">
        {weekSpanLabel(round.from, round.to)}
        {round.to > round.from && ` · ${round.to - round.from + 1} wks`}
      </p>
    </div>
  );
}

function TimelineLegend({ rows }: { rows: TimelineRow[] }) {
  const shared = sharedWeeks(rows);
  const anyAutomatic = rows.some((r) => r.rounds.some((x) => x.automatic));
  const past = rows.some((r) => r.rounds.some((x) => x.to > NFL_LAST_WEEK));
  const flagged = rows.some((r) => r.rounds.some((x) => x.flagged));

  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {shared.length > 0 && (
        <span>
          Both brackets play in week{shared.length === 1 ? "" : "s"}{" "}
          {shared.join(", ")}.
        </span>
      )}
      {anyAutomatic && (
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-3 w-4 rounded-sm border border-dashed border-accent/60"
          />
          Worked out from playoff teams
        </span>
      )}
      {(past || flagged) && (
        <span className="font-medium text-negative">
          Red rounds need fixing
          {past && `; anything after week ${NFL_LAST_WEEK} is past the NFL season`}.
        </span>
      )}
    </div>
  );
}

/**
 * Desktop: weeks across, one row per bracket, so a round in one bracket
 * sits directly above whatever the other bracket is doing that week.
 */
export function TimelineAcross({ rows }: { rows: TimelineRow[] }) {
  const weeks = weekRange(rows);
  const labelId = useId();
  if (weeks.length === 0) return null;
  const first = weeks[0];

  return (
    <figure className="space-y-2" aria-labelledby={labelId}>
      <figcaption id={labelId} className="text-sm font-semibold">
        Schedule preview
      </figcaption>
      <div
        className="grid gap-x-1.5 gap-y-2"
        style={{
          gridTemplateColumns: `9rem repeat(${weeks.length}, minmax(0, 1fr))`,
        }}
      >
        <span />
        {weeks.map((w) => (
          <span
            key={w}
            className={`rounded-sm px-1 py-0.5 text-center text-xs tabular-nums ${
              w > NFL_LAST_WEEK
                ? "bg-negative/10 font-semibold text-negative"
                : "text-muted"
            }`}
          >
            Wk {w}
          </span>
        ))}

        {rows.map((row, r) => (
          <Fragment key={row.bracket}>
            <span
              className="self-center truncate text-sm font-medium"
              style={{ gridRow: r + 2, gridColumn: 1 }}
            >
              {row.title}
            </span>
            {/* Faint week cells behind the bars, so empty weeks read as empty. */}
            {weeks.map((w, i) => (
              <span
                key={`cell-${w}`}
                aria-hidden
                className="min-h-12 rounded-md bg-surface-2/60"
                style={{ gridRow: r + 2, gridColumn: i + 2 }}
              />
            ))}
            {row.rounds.length === 0 ? (
              <span
                className="self-center px-2 text-xs text-muted"
                style={{ gridRow: r + 2, gridColumn: `2 / span ${weeks.length}` }}
              >
                {row.emptyText}
              </span>
            ) : (
              row.rounds.map((round) => (
                // The tint is see-through, so the bar sits on a solid surface;
                // otherwise the week cells behind a long round show through.
                <div
                  key={round.key}
                  className="min-w-0 rounded-md bg-surface"
                  style={{
                    gridRow: r + 2,
                    gridColumn: `${round.from - first + 2} / span ${
                      round.to - round.from + 1
                    }`,
                  }}
                >
                  <RoundBar row={row} round={round} />
                </div>
              ))
            )}
          </Fragment>
        ))}
      </div>
      <TimelineLegend rows={rows} />
    </figure>
  );
}

/**
 * Phone: weeks down, a column per bracket. Narrow enough for 375px with
 * the round names still readable.
 */
export function TimelineDown({ rows }: { rows: TimelineRow[] }) {
  const weeks = weekRange(rows);
  const labelId = useId();
  if (weeks.length === 0) return null;
  const first = weeks[0];

  return (
    <figure className="space-y-2" aria-labelledby={labelId}>
      <figcaption id={labelId} className="text-sm font-semibold">
        Schedule preview
      </figcaption>
      <div
        className="grid gap-x-1.5 gap-y-1"
        style={{
          gridTemplateColumns: `2.75rem repeat(${rows.length}, minmax(0, 1fr))`,
        }}
      >
        <span />
        {rows.map((row, c) => (
          <span
            key={row.bracket}
            className="truncate text-xs font-semibold"
            style={{ gridRow: 1, gridColumn: c + 2 }}
          >
            {row.title}
          </span>
        ))}

        {weeks.map((w, i) => (
          <Fragment key={w}>
            <span
              className={`self-center text-xs tabular-nums ${
                w > NFL_LAST_WEEK ? "font-semibold text-negative" : "text-muted"
              }`}
              style={{ gridRow: i + 2, gridColumn: 1 }}
            >
              Wk {w}
            </span>
            {rows.map((row, c) => (
              <span
                key={`${row.bracket}-${w}`}
                aria-hidden
                className="min-h-11 rounded-md bg-surface-2/60"
                style={{ gridRow: i + 2, gridColumn: c + 2 }}
              />
            ))}
          </Fragment>
        ))}

        {rows.map((row, c) =>
          row.rounds.map((round) => (
            <div
              key={`${row.bracket}-${round.key}`}
              className="flex min-w-0 flex-col rounded-md bg-surface"
              style={{
                gridColumn: c + 2,
                gridRow: `${round.from - first + 2} / span ${
                  round.to - round.from + 1
                }`,
              }}
            >
              <div className={`${barClass(row, round)} flex-1`}>
                <p className="line-clamp-2 text-xs leading-tight font-semibold break-words">
                  {round.name}
                </p>
                {round.to > round.from && (
                  <p className="text-[11px] text-muted">
                    {round.to - round.from + 1} weeks
                  </p>
                )}
              </div>
            </div>
          )),
        )}
      </div>
      {rows.some((r) => r.rounds.length === 0) && (
        <p className="text-xs text-muted">
          {rows
            .filter((r) => r.rounds.length === 0)
            .map((r) => `${r.title}: ${r.emptyText}`)
            .join(" ")}
        </p>
      )}
      <TimelineLegend rows={rows} />
    </figure>
  );
}
