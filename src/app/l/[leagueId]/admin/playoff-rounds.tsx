"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  losersEntrantCount,
  losersShape,
  roundSpans,
  validateLosersBracket,
  winnersShape,
  type LosersSettings,
  type RoundConfig,
  type RoundShape,
  type SeedingSettings,
} from "@/lib/playoff-bracket";
import { useWideScreen } from "@/lib/use-wide-screen";
import { savePlayoffRounds, type AdminResult } from "./actions";
import {
  ChoiceGroup,
  ENTRANT_OPTIONS,
  FieldErrors,
  MODE_OPTIONS,
  RESEED_OPTIONS,
  RoundEditor,
  TiebreakerOrder,
  TimelineAcross,
  TimelineDown,
  defaultRoundName,
  losersTitle,
  placeProblems,
  problemAnchor,
  problemsFor,
  tiebreakNote,
  tiebreakOptions,
  type Problem,
  type TimelineRow,
} from "./playoff-setup-parts";

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

/** Rounds as the save action reads them. */
function toConfig(rounds: PlayoffRound[]): RoundConfig[] {
  return rounds.map((r) => ({
    name: r.name,
    weeks: r.weeks,
    teams: r.teams && r.teams >= 2 ? r.teams : null,
    byes: Math.max(0, r.byes),
  }));
}

/**
 * The shape of the playoffs.
 *
 * Rounds are laid end to end from their bracket's first week, so a
 * two-week semi-final pushes the final back on its own -- there is no
 * separate "which week is the final" setting to keep in step.
 *
 * Each round says how big its field is and how many of that field are on
 * a bye. Leaving the field blank keeps the old behaviour, which is that
 * everybody still standing plays. Byes always come off the top seeds,
 * and the number is adjusted by one where the field would otherwise not
 * pair off -- see settleByes. Every round shows what it will actually
 * produce, so none of that has to be worked out by hand.
 *
 * The losers bracket is a separate tournament with its own first week,
 * entrants, mode and seeding. Nothing about it is assumed: turning it on
 * means choosing each. The problems listed under it are the ones the
 * save action refuses (src/lib/playoff-bracket.ts).
 *
 * This component owns the state and the save; the two views below only
 * lay it out. Desktop puts the brackets side by side under a timeline
 * with weeks across, because this is a decision best made seeing both at
 * once. The phone stacks everything under a timeline with weeks down.
 */
export function PlayoffRounds({
  leagueId,
  startWeek,
  playoffTeams,
  teamCount,
  rounds,
  losers: savedLosers,
  seeding: savedSeeding,
}: {
  leagueId: string;
  startWeek: number;
  playoffTeams: number;
  teamCount: number;
  rounds: PlayoffRound[];
  losers: LosersSettings;
  seeding: SeedingSettings;
}) {
  const router = useRouter();
  const wide = useWideScreen();
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
  const [settings, setSettings] = useState<LosersSettings>(savedLosers);
  const [seeding, setSeeding] = useState<SeedingSettings>(savedSeeding);

  const winnersPlan = winnersShape({
    playoffStartWeek: startWeek,
    playoffTeams,
    teamCount,
    rounds: toConfig(winners),
  });
  const entrants =
    settings.enabled && settings.entrants && settings.startWeek != null
      ? losersEntrantCount(settings, winnersPlan, teamCount)
      : null;
  const entrantCount = entrants && "count" in entrants ? entrants.count : null;
  const problems = placeProblems(
    validateLosersBracket({
      settings,
      rounds: toConfig(losers),
      playoffStartWeek: startWeek,
      playoffTeams,
      teamCount,
      winnersRounds: toConfig(winners),
    }),
  );

  function patchSettings(changes: Partial<LosersSettings>) {
    setSettings((current) => ({ ...current, ...changes }));
  }

  function patchSeeding(changes: Partial<SeedingSettings>) {
    setSeeding((current) => ({ ...current, ...changes }));
  }

  function save() {
    startTransition(async () => {
      const outcome = await savePlayoffRounds(
        leagueId,
        [
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
        ],
        settings,
        seeding,
      );
      setResult(outcome);
      if (!outcome.error) router.refresh();
    });
  }

  // What the losers bracket's configured rounds will do, once there is
  // a first week and a field to play them with.
  const losersStart = settings.startWeek ?? startWeek;
  const losersPlan: RoundShape[] =
    entrantCount !== null && entrantCount >= 2 && settings.startWeek != null
      ? losersShape(settings.startWeek, entrantCount, toConfig(losers), true)
      : [];

  const timeline: TimelineRow[] = [
    {
      bracket: "winners",
      title: "Championship",
      emptyText: "Needs at least two playoff teams.",
      rounds: winnersPlan.map((shape, i) => ({
        key: `w${shape.index}`,
        name:
          winners[i]?.name.trim() ||
          defaultRoundName("winners", null, shape.index, shape),
        from: shape.from,
        to: shape.to,
        automatic: i >= winners.length,
        detail: `${shape.field} teams, ${shape.games} games, ${shape.byes} byes`,
      })),
    },
    {
      bracket: "losers",
      title: settings.enabled ? losersTitle(settings.mode) : "Losers bracket",
      emptyText: !settings.enabled
        ? "Off."
        : settings.startWeek == null
          ? "Choose a first week."
          : "No rounds yet.",
      rounds:
        settings.enabled && settings.startWeek != null
          ? roundSpans(settings.startWeek, losers).map((span, i) => {
              const shape = losersPlan[i];
              return {
                key: `l${i + 1}`,
                name:
                  losers[i].name.trim() ||
                  defaultRoundName("losers", settings.mode, i + 1, shape),
                from: span.from,
                to: span.to,
                automatic: false,
                flagged:
                  problemsFor(problems, { round: i + 1 }).length > 0 ||
                  (i === 0 && problemsFor(problems, "startWeek").length > 0),
                detail: shape
                  ? `${shape.field} teams, ${shape.games} games, ${shape.byes} byes`
                  : "field not known yet",
              };
            })
          : [],
    },
  ];

  const model: SetupModel = {
    startWeek,
    playoffField: Math.min(playoffTeams, teamCount),
    winners,
    setWinners,
    winnersPlan,
    losers,
    setLosers,
    losersPlan,
    losersStart,
    settings,
    patchSettings,
    seeding,
    patchSeeding,
    entrantCount,
    problems,
    timeline,
    result,
    pending,
    save,
  };

  return wide ? <DesktopView model={model} /> : <MobileView model={model} />;
}

interface SetupModel {
  startWeek: number;
  playoffField: number;
  winners: PlayoffRound[];
  setWinners: (next: PlayoffRound[]) => void;
  winnersPlan: RoundShape[];
  losers: PlayoffRound[];
  setLosers: (next: PlayoffRound[]) => void;
  losersPlan: RoundShape[];
  losersStart: number;
  settings: LosersSettings;
  patchSettings: (changes: Partial<LosersSettings>) => void;
  seeding: SeedingSettings;
  patchSeeding: (changes: Partial<SeedingSettings>) => void;
  entrantCount: number | null;
  problems: Problem[];
  timeline: TimelineRow[];
  result: AdminResult;
  pending: boolean;
  save: () => void;
}

// Views ----------------------------------------------------------------------

function Intro() {
  return (
    <div>
      <h3 className="h2">Playoff brackets</h3>
      <p className="muted">
        Two separate tournaments that can share weeks. Rounds run back to back
        from each bracket&apos;s first week; a two-week round is one matchup
        scored over both weeks.
      </p>
    </div>
  );
}

function DesktopView({ model }: { model: SetupModel }) {
  return (
    <section className="card space-y-5">
      <Intro />
      <div className="rounded-lg border border-border p-3">
        <TimelineAcross rows={model.timeline} />
      </div>
      <SeedingPanel model={model} />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <WinnersPanel model={model} framed />
        <LosersPanel model={model} framed />
      </div>
      <SaveBar model={model} />
    </section>
  );
}

function MobileView({ model }: { model: SetupModel }) {
  return (
    <section className="card space-y-5">
      <Intro />
      <TimelineDown rows={model.timeline} />
      <SeedingPanel model={model} />
      <WinnersPanel model={model} />
      <LosersPanel model={model} />
      <SaveBar model={model} />
    </section>
  );
}

/**
 * On desktop each bracket is its own bordered panel. On a phone the
 * border would cost 24px of a 343px column, so a rule and a heading do
 * the separating instead.
 */
function panelClass(framed: boolean | undefined, tone: "winners" | "losers") {
  const edge = tone === "winners" ? "border-t-accent" : "border-t-muted";
  return framed
    ? `space-y-4 rounded-lg border border-border border-t-4 ${edge} bg-surface p-4`
    : `space-y-4 border-t-4 ${edge} pt-4`;
}

/**
 * How the seeds are worked out in the first place.
 *
 * League-wide rather than per bracket: both brackets are drawn from the
 * one regular season table, so the order only has to be decided once.
 * Wins and losses always come first and are not a choice.
 */
function SeedingPanel({ model }: { model: SetupModel }) {
  const { seeding, patchSeeding } = model;

  return (
    // Framed and tinted on both views, where a bracket panel is a
    // coloured top edge: this one setting feeds both brackets, so it
    // should not look like a third bracket.
    <section
      aria-labelledby="seeding-heading"
      className="space-y-3 rounded-lg border border-border bg-surface-2/50 p-4"
    >
      <header className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 id="seeding-heading" className="text-base font-semibold">
            Seeding order
          </h4>
          <span className="pill">Applies to both brackets</span>
        </div>
        <p className="text-xs text-muted">
          How the regular season table becomes seeds, before either bracket
          is drawn. Wins come first, then losses — those are not a choice.
          The list below settles teams still level, in the order you put
          them in.
        </p>
      </header>

      <TiebreakerOrder
        id="seeding-tiebreakers"
        value={seeding.tiebreakers}
        onChange={(tiebreakers) => patchSeeding({ tiebreakers })}
      />
    </section>
  );
}

function WinnersPanel({
  model,
  framed,
}: {
  model: SetupModel;
  framed?: boolean;
}) {
  const { startWeek, playoffField, winners, setWinners, winnersPlan } = model;
  const { seeding, patchSeeding } = model;

  return (
    <div className={panelClass(framed, "winners")}>
      <header className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-base font-semibold">Championship bracket</h4>
          <span className="pill">Winners advance</span>
        </div>
        <p className="text-xs text-muted">
          Starts week {startWeek} with {playoffField} team
          {playoffField === 1 ? "" : "s"}. Change those in League settings
          above.
        </p>
      </header>

      <ChoiceGroup
        id="winners-reseed"
        name="winners-reseed"
        legend="Seeding after round 1"
        options={RESEED_OPTIONS}
        value={seeding.winnersReseed}
        onChange={(winnersReseed) => patchSeeding({ winnersReseed })}
        problems={[]}
      />

      <ChoiceGroup
        id="winners-tiebreak"
        name="winners-tiebreak"
        legend="If a game ends level"
        note={tiebreakNote("winners", null)}
        options={tiebreakOptions(false)}
        value={seeding.winnersTiebreak}
        onChange={(winnersTiebreak) => patchSeeding({ winnersTiebreak })}
        problems={[]}
      />

      <RoundEditor
        bracket="winners"
        mode={null}
        startWeek={startWeek}
        rounds={winners}
        setRounds={setWinners}
        shapes={winnersPlan}
        spans={roundSpans(startWeek, winners)}
        defaultField={playoffField}
        problems={[]}
        emptyHint={`No rounds set, so the bracket plays one-week rounds from week ${startWeek} until one team is left (dashed in the preview). Add rounds to name them or make one longer.`}
      />
    </div>
  );
}

function LosersPanel({
  model,
  framed,
}: {
  model: SetupModel;
  framed?: boolean;
}) {
  const { settings, patchSettings, problems, entrantCount, losers } = model;
  const on = settings.enabled;
  const unchosen =
    on &&
    !settings.entrants &&
    !settings.mode &&
    !settings.reseed &&
    settings.startWeek == null;
  // An empty box already wears "Choose one"; see ChoiceGroup.
  const startProblems =
    settings.startWeek == null ? [] : problemsFor(problems, "startWeek");
  const startInvalid = startProblems.length > 0;

  return (
    <div className={panelClass(framed, "losers")}>
      <header className="flex items-center justify-between gap-2">
        <h4 className="text-base font-semibold">
          {on ? losersTitle(settings.mode) : "Losers bracket"}
        </h4>
        {!on ? (
          <span className="pill">Off</span>
        ) : unchosen ? (
          <span className="badge-todo">Not set up</span>
        ) : problems.length > 0 ? (
          <span className="badge-negative">{problems.length} to fix</span>
        ) : (
          <span className="pill border-positive/40 text-positive">Ready</span>
        )}
      </header>

      <label className="choice">
        <input
          type="checkbox"
          role="switch"
          checked={on}
          onChange={(e) => patchSettings({ enabled: e.target.checked })}
        />
        <span className="min-w-0">
          <span className="block font-medium">Run a losers bracket</span>
          <span className="block text-xs text-muted">
            A second tournament for teams out of the title race, with its own
            weeks, rounds and seeds.
          </span>
        </span>
      </label>

      {!on && losers.length > 0 && (
        <p className="text-xs text-muted">
          Its {losers.length} round{losers.length === 1 ? " is" : "s are"} kept
          for when you turn it back on.
        </p>
      )}

      {on && (
        <>
          {unchosen && (
            <p className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm">
              Nothing is assumed. Choose who plays, who advances, how it&apos;s
              seeded and when it starts.
            </p>
          )}

          <ChoiceGroup
            id={problemAnchor("entrants")}
            name="losers-entrants"
            legend="Who plays in it"
            options={ENTRANT_OPTIONS}
            value={settings.entrants}
            onChange={(entrants) => patchSettings({ entrants })}
            problems={problemsFor(problems, "entrants")}
          />

          <ChoiceGroup
            id={problemAnchor("mode")}
            name="losers-mode"
            legend="Who advances"
            options={MODE_OPTIONS}
            value={settings.mode}
            onChange={(mode) => patchSettings({ mode })}
            problems={problemsFor(problems, "mode")}
          />

          <ChoiceGroup
            id={problemAnchor("reseed")}
            name="losers-reseed"
            legend="Seeding after round 1"
            note={
              settings.mode === "toilet_bowl"
                ? "Seeds run the other way in a toilet bowl: its top seed is the worst team left."
                : undefined
            }
            options={RESEED_OPTIONS}
            value={settings.reseed}
            onChange={(reseed) => patchSettings({ reseed })}
            problems={problemsFor(problems, "reseed")}
          />

          <ChoiceGroup
            id="losers-tiebreak"
            name="losers-tiebreak"
            legend={
              settings.mode === "toilet_bowl"
                ? "If a toilet bowl game ends level"
                : "If a game ends level"
            }
            note={tiebreakNote("losers", settings.mode)}
            options={tiebreakOptions(settings.mode === "toilet_bowl")}
            value={model.seeding.losersTiebreak}
            onChange={(losersTiebreak) =>
              model.patchSeeding({ losersTiebreak })
            }
            problems={[]}
          />

          <div id={problemAnchor("startWeek")} className="scroll-mt-24">
            <div className="mb-1 flex items-center justify-between gap-2">
              <label
                className="text-sm font-semibold"
                htmlFor="losers-start-week"
              >
                First week
              </label>
              {settings.startWeek == null && (
                <span className="badge-todo">Choose one</span>
              )}
            </div>
            <input
              id="losers-start-week"
              className="input max-w-32"
              type="number"
              inputMode="numeric"
              min={1}
              max={18}
              placeholder="Week"
              value={settings.startWeek ?? ""}
              aria-invalid={startInvalid || undefined}
              aria-describedby="losers-start-week-hint losers-start-week-errors"
              onChange={(e) =>
                patchSettings({
                  startWeek: e.target.value ? Number(e.target.value) : null,
                })
              }
            />
            <p id="losers-start-week-hint" className="mt-1 text-xs text-muted">
              The playoffs start week {model.startWeek}. Start the same week a
              championship round starts, or after the final.
            </p>
            <FieldErrors id="losers-start-week-errors" problems={startProblems} />
          </div>

          {entrantCount !== null && (
            <p className="text-sm">
              <span className="font-semibold tabular-nums">{entrantCount}</span>{" "}
              team{entrantCount === 1 ? "" : "s"} will enter, going by the
              saved playoff settings.
            </p>
          )}

          <div className="space-y-2">
            <h5 className="text-sm font-semibold">Rounds</h5>
            <RoundEditor
              bracket="losers"
              mode={settings.mode}
              startWeek={model.losersStart}
              rounds={losers}
              setRounds={model.setLosers}
              shapes={model.losersPlan}
              spans={roundSpans(model.losersStart, losers)}
              defaultField={entrantCount ?? 0}
              problems={problems}
              emptyHint="No rounds yet. Add one for each round the losers bracket plays."
            />
          </div>
        </>
      )}
    </div>
  );
}

function SaveBar({ model }: { model: SetupModel }) {
  const { problems, result, pending, save } = model;

  return (
    <div className="space-y-3 border-t border-border pt-4">
      {problems.length > 0 && (
        <div className="error-box space-y-1">
          <p className="font-semibold">
            Fix {problems.length === 1 ? "this" : `these ${problems.length}`}{" "}
            before saving:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            {problems.map((p) => (
              <li key={p.text}>
                <a
                  href={`#${problemAnchor(p.target)}`}
                  className="underline decoration-negative/50 underline-offset-2 hover:decoration-negative"
                >
                  {p.text}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.error && <p className="error-box">{result.error}</p>}
      {result.ok && <p className="ok-box">{result.ok}</p>}

      <div className="flex flex-col gap-2 md:flex-row-reverse md:items-center md:justify-between md:gap-4">
        <button
          type="button"
          className="btn btn-primary w-full md:w-auto"
          disabled={pending}
          onClick={save}
        >
          {pending ? "Saving..." : "Save playoff brackets"}
        </button>
        <p className="muted text-xs">
          Saving doesn&apos;t move a bracket that&apos;s already been generated.
          Regenerate it from the Tools tab.
        </p>
      </div>
    </div>
  );
}
