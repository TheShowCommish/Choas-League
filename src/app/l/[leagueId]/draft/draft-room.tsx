"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  AUTODRAFT_LABELS,
  type AutodraftStrategy,
  type Draft,
  type DraftPick,
  type RosterSlot,
  type Team,
} from "@/lib/types";
import { byPosition, expandSlots, positionLabel, slotAccepts } from "@/lib/roster-slots";
import { describeInjury, INJURY_CLASS } from "@/lib/injury";
import type { DraftablePlayer, PickedPlayer, QueueEntry } from "./page";
import {
  makePick,
  queuePlayer,
  reorderQueue,
  runAutopick,
  setAutodraftStrategy,
  setQueueRound,
  unqueuePlayer,
} from "./actions";

/**
 * The draft room.
 *
 * Every browser in the room subscribes to draft_picks and drafts over
 * realtime, so a pick made anywhere refreshes everyone's board. The
 * clock is rendered from the server's pick_deadline rather than a local
 * countdown, so a slow phone and a fast laptop agree on the time left.
 *
 * Three columns on a wide screen: the board down the left, the pool in
 * the middle, your queue and your roster on the right. The page escapes
 * the usual reading column (see main-width.tsx) because all three are
 * working at once and none of them has room to spare.
 */
export function DraftRoom({
  leagueId,
  draft,
  picks,
  teams,
  myTeamId,
  isCommissioner,
  available,
  pickedPlayers,
  queue: initialQueue,
  rosterSlots,
  seasonLabel,
  autodraftStrategy,
  autopickName,
}: {
  leagueId: string;
  draft: Draft;
  picks: DraftPick[];
  teams: Team[];
  myTeamId: string | null;
  isCommissioner: boolean;
  available: DraftablePlayer[];
  pickedPlayers: PickedPlayer[];
  queue: QueueEntry[];
  rosterSlots: RosterSlot[];
  seasonLabel: string;
  /** How autopick chooses for *your* team once the queue runs dry. */
  autodraftStrategy: AutodraftStrategy;
  /** Who that would be right now, as the database would answer it. */
  autopickName: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [position, setPosition] = useState("");
  const [sort, setSort] = useState<PoolSort>("adp");
  const [strategy, setStrategy] = useState<AutodraftStrategy>(autodraftStrategy);

  /*
   * The queue is held locally so reordering and round changes feel
   * immediate; the server remains the authority.
   *
   * Reconciled during render rather than in an effect. Every pick in the
   * room triggers a refresh, so the queue prop arrives as a fresh array
   * many times a draft; comparing what it says rather than which array
   * it is keeps an optimistic reorder from being thrown away by somebody
   * else's pick landing.
   */
  const signature = (rows: QueueEntry[]) =>
    rows.map((r) => `${r.player_id}:${r.target_round ?? ""}`).join("|");

  const [queue, setQueue] = useState<QueueEntry[]>(initialQueue);
  const [serverQueue, setServerQueue] = useState(() => signature(initialQueue));

  if (signature(initialQueue) !== serverQueue) {
    setServerQueue(signature(initialQueue));
    setQueue(initialQueue);
  }

  const [rosterTeamId, setRosterTeamId] = useState<string>(
    myTeamId ?? teams[0]?.id ?? "",
  );

  const teamById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);

  /** Every drafted player, by id. The board's only source of names. */
  const playerById = useMemo(
    () => new Map(pickedPlayers.map((p) => [p.id, p])),
    [pickedPlayers],
  );

  const currentPick = picks.find(
    (p) => p.pick_number === draft.current_pick_number,
  );
  const onTheClock = currentPick ? teamById.get(currentPick.team_id) : null;
  const isMyPick = currentPick?.team_id === myTeamId;
  const canPick =
    draft.status === "live" && (isMyPick || isCommissioner) && !!currentPick;
  const currentRound = currentPick?.round ?? 1;

  /** The next few teams to pick, so nobody has to count down the board. */
  const onDeck = useMemo(
    () =>
      picks
        .filter((p) => p.pick_number > draft.current_pick_number && !p.player_id)
        .slice(0, 4),
    [picks, draft.current_pick_number],
  );

  // --- realtime -------------------------------------------------------
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`draft-${draft.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "draft_picks", filter: `draft_id=eq.${draft.id}` },
        () => router.refresh(),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "drafts", filter: `id=eq.${draft.id}` },
        () => router.refresh(),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [draft.id, router]);

  // --- the clock ------------------------------------------------------
  // Only `now` is state, and it is written solely from the interval
  // callback -- deriving the countdown during render avoids the
  // cascading re-render an effect-driven counter would cause.
  const deadlineMs =
    draft.status === "live" && draft.pick_deadline
      ? new Date(draft.pick_deadline).getTime()
      : null;

  const [now, setNow] = useState(() => Date.now());
  const autopickFired = useRef(false);

  useEffect(() => {
    autopickFired.current = false;
    if (deadlineMs === null) return;

    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [deadlineMs]);

  const secondsLeft =
    deadlineMs === null
      ? null
      : Math.max(0, Math.round((deadlineMs - now) / 1000));

  useEffect(() => {
    if (secondsLeft !== 0 || !draft.autopick_enabled) return;
    if (autopickFired.current) return;

    // Whoever has the room open nudges the server. The RPC re-checks the
    // deadline itself, so several browsers racing here is harmless.
    autopickFired.current = true;
    void runAutopick(leagueId, draft.id).then(() => router.refresh());
  }, [secondsLeft, draft.autopick_enabled, draft.id, leagueId, router]);

  // --- actions --------------------------------------------------------
  const pick = useCallback(
    (playerId: string, playerName: string) => {
      if (!confirm(`Draft ${playerName}?`)) return;
      startTransition(async () => {
        const result = await makePick(leagueId, draft.id, playerId);
        setError(result.error ?? null);
        router.refresh();
      });
    },
    [leagueId, draft.id, router],
  );

  const queuedIds = useMemo(
    () => new Set(queue.map((q) => q.player_id)),
    [queue],
  );

  function toggleQueue(player: DraftablePlayer) {
    if (!myTeamId) return;

    if (queuedIds.has(player.player_id)) {
      setQueue((prev) => prev.filter((q) => q.player_id !== player.player_id));
      startTransition(async () => {
        await unqueuePlayer(myTeamId, player.player_id);
      });
      return;
    }

    const entry: QueueEntry = {
      player_id: player.player_id,
      rank: queue.length + 1,
      target_round: null,
      full_name: player.full_name,
      position: player.pos,
      team_abbr: player.team_abbr,
      adp: player.adp,
    };
    setQueue((prev) => [...prev, entry]);
    startTransition(async () => {
      await queuePlayer(myTeamId, player.player_id, queue.length + 1, null);
    });
  }

  function moveInQueue(playerId: string, by: number) {
    if (!myTeamId) return;

    const index = queue.findIndex((q) => q.player_id === playerId);
    const target = index + by;
    if (index === -1 || target < 0 || target >= queue.length) return;

    const next = [...queue];
    [next[index], next[target]] = [next[target], next[index]];
    setQueue(next.map((entry, i) => ({ ...entry, rank: i + 1 })));

    startTransition(async () => {
      await reorderQueue(
        myTeamId,
        next.map((q) => q.player_id),
      );
    });
  }

  function changeRound(playerId: string, round: number | null) {
    if (!myTeamId) return;
    setQueue((prev) =>
      prev.map((q) =>
        q.player_id === playerId ? { ...q, target_round: round } : q,
      ),
    );
    startTransition(async () => {
      await setQueueRound(myTeamId, playerId, round);
    });
  }

  function removeFromQueue(playerId: string) {
    if (!myTeamId) return;
    setQueue((prev) => prev.filter((q) => q.player_id !== playerId));
    startTransition(async () => {
      await unqueuePlayer(myTeamId, playerId);
    });
  }

  function changeStrategy(next: AutodraftStrategy) {
    if (!myTeamId) return;
    setStrategy(next);
    startTransition(async () => {
      const result = await setAutodraftStrategy(leagueId, myTeamId, next);
      setError(result.error ?? null);
      router.refresh();
    });
  }

  // --- derived lists --------------------------------------------------
  const draftedIds = useMemo(
    () =>
      new Set(
        picks.filter((p) => p.player_id).map((p) => p.player_id as string),
      ),
    [picks],
  );

  /**
   * What "Flex" means here.
   *
   * Not a position anybody plays -- it is whatever this league's flex
   * slots accept, which is why it is read off the roster rather than
   * hard-coded to RB/WR/TE.
   */
  const flexPositions = useMemo(() => {
    const positions = new Set<string>();
    for (const slot of rosterSlots) {
      if (!slot.is_starter || slot.eligible_positions.length <= 1) continue;
      for (const p of slot.eligible_positions) positions.add(p);
    }
    return positions.size > 0 ? positions : new Set(["RB", "WR", "TE"]);
  }, [rosterSlots]);

  // Flex is sorted in with the rest rather than pinned to the front, so
  // this menu reads in the same order as every other position list in
  // the app: QB, RB, WR, TE, FLEX, D/ST, K, P, HC.
  const positions = useMemo(
    () =>
      [
        ...new Set([
          ...available.map((p) => p.pos).filter(Boolean),
          "FLEX",
        ]),
      ].sort((a, b) => byPosition(a as string, b as string)),
    [available],
  );

  /**
   * "RB4" -- where a player sits among the running backs still on the
   * board, by ADP.
   *
   * Among those *still on the board* rather than all of them, which is
   * the number a draft actually turns on: knowing the man in front of
   * you is the fourth-best remaining back is what tells you whether to
   * take him now or wait a round.
   */
  const positionRankById = useMemo(() => {
    const remaining = available.filter((p) => !draftedIds.has(p.player_id));
    const counters = new Map<string, number>();
    const ranks = new Map<string, number>();

    for (const player of [...remaining].sort(
      (a, b) => (a.adp ?? Infinity) - (b.adp ?? Infinity),
    )) {
      if (!player.pos) continue;
      const next = (counters.get(player.pos) ?? 0) + 1;
      counters.set(player.pos, next);
      ranks.set(player.player_id, next);
    }
    return ranks;
  }, [available, draftedIds]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();

    const rows = available.filter((p) => {
      if (draftedIds.has(p.player_id)) return false;
      if (query && !p.full_name.toLowerCase().includes(query)) return false;
      if (!position) return true;
      if (position === "FLEX") return !!p.pos && flexPositions.has(p.pos);
      return p.pos === position;
    });

    if (sort === "points") {
      return [...rows].sort(
        (a, b) => Number(b.total_points) - Number(a.total_points),
      );
    }
    if (sort === "projection") {
      // Anybody with no projection at the back rather than mixed in
      // among the zeroes.
      return [...rows].sort(
        (a, b) => (b.proj_points ?? -1) - (a.proj_points ?? -1),
      );
    }
    // ADP ascending, with anybody unranked at the back rather than first.
    return [...rows].sort(
      (a, b) => (a.adp ?? Infinity) - (b.adp ?? Infinity),
    );
  }, [available, draftedIds, search, position, sort, flexPositions]);

  const rosterTeam = teamById.get(rosterTeamId) ?? null;

  return (
    <div className="space-y-4">
      <header className="card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="h1">{seasonLabel} Draft</h1>
            <p className="muted text-sm">
              {draft.type === "snake" ? "Snake" : "Auction"} &middot;{" "}
              {draft.rounds} rounds &middot; {draft.status}
            </p>
          </div>

          {draft.status === "live" && secondsLeft !== null && (
            <div
              suppressHydrationWarning
              className={`text-3xl font-bold tabular-nums ${
                secondsLeft <= 10 ? "text-negative" : ""
              }`}
            >
              {Math.floor(secondsLeft / 60)}:
              {String(secondsLeft % 60).padStart(2, "0")}
            </div>
          )}
        </div>

        {draft.status !== "live" ? (
          <p className="ok-box mt-3">
            {draft.status === "complete"
              ? "The draft is finished."
              : draft.status === "paused"
                ? "The draft is paused."
                : "The draft has not started yet. The commissioner opens it."}
          </p>
        ) : currentPick ? (
          <div className="mt-3 space-y-2">
            <p className={isMyPick ? "ok-box" : "muted"}>
              Pick {currentPick.pick_number} &middot; round {currentPick.round} —{" "}
              <strong>
                {isMyPick ? "You are on the clock" : onTheClock?.name}
              </strong>
            </p>

            {onDeck.length > 0 && (
              <p className="muted text-xs">
                Then:{" "}
                {onDeck
                  .map((p) => teamById.get(p.team_id)?.name ?? "—")
                  .join(" → ")}
              </p>
            )}
          </div>
        ) : null}

        {myTeamId && draft.autopick_enabled && draft.status === "live" && (
          <p
            className={`mt-3 rounded-md border px-3 py-2 text-sm ${
              isMyPick
                ? "border-accent/50 bg-accent/10"
                : "border-border bg-surface-2"
            }`}
          >
            {autopickName ? (
              <>
                If your clock runs out, autodraft takes{" "}
                <strong>{autopickName}</strong>
                <span className="muted">
                  {" "}
                  &mdash;{" "}
                  {queue.some(
                    (q) =>
                      q.target_round === null || q.target_round <= currentRound,
                  )
                    ? "top of your queue"
                    : AUTODRAFT_LABELS[strategy].toLowerCase()}
                </span>
              </>
            ) : (
              <span className="muted">
                Autodraft has nobody to take &mdash; queue somebody, or check
                your autodraft setting.
              </span>
            )}
          </p>
        )}

        {error && <p className="error-box mt-3">{error}</p>}
      </header>

      <div className="grid gap-4 lg:grid-cols-[16rem_1fr_23rem] 2xl:grid-cols-[18rem_1fr_26rem]">
        <DraftBoard
          picks={picks}
          teams={teams}
          playerById={playerById}
          currentPickNumber={draft.current_pick_number}
          myTeamId={myTeamId}
        />

        <section className="space-y-3">
          <div className="card flex flex-wrap gap-2">
            <input
              className="input min-w-40 flex-1"
              placeholder="Search players"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search players"
            />
            <select
              className="input w-32"
              value={position}
              onChange={(e) => setPosition(e.target.value)}
              aria-label="Position"
            >
              <option value="">All</option>
              {positions.map((p) => (
                <option key={p} value={p!}>
                  {p === "FLEX" ? "Flex" : positionLabel(p)}
                </option>
              ))}
            </select>
            <select
              className="input w-44"
              value={sort}
              onChange={(e) => setSort(e.target.value as PoolSort)}
              aria-label="Sort by"
            >
              <option value="adp">By ADP</option>
              <option value="projection">By {seasonLabel} projection</option>
              <option value="points">By last season</option>
            </select>
          </div>

          <div className="card-tight table-scroll max-h-[75vh] overflow-y-auto">
            <table className="table">
              <thead className="sticky top-0 z-10 bg-surface">
                <tr>
                  <th className="w-14 text-right">ADP</th>
                  <th>Player</th>
                  <th className="w-16 text-right" title="Projected fantasy points this season, in this league's scoring">
                    Proj
                  </th>
                  <th className="w-16 text-right" title="What he scored last season in this league's scoring">
                    Last
                  </th>
                  <th className="w-28" />
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted py-6 text-center">
                      Nobody left matching that.
                    </td>
                  </tr>
                )}
                {filtered.map((player) => {
                  const injury = describeInjury(player);
                  const posRank = positionRankById.get(player.player_id);

                  return (
                    <tr key={player.player_id}>
                      <td className="muted text-right text-xs tabular-nums">
                        {player.adp === null
                          ? "—"
                          : Number(player.adp).toFixed(1)}
                      </td>
                      <td>
                        <span className="flex flex-wrap items-center gap-x-2">
                          <span className="font-medium">
                            {player.full_name}
                          </span>
                          {injury && (
                            <span
                              className={`rounded border px-1 text-[10px] font-semibold ${
                                INJURY_CLASS[injury.tone]
                              }`}
                              title={`${injury.outlook}${
                                injury.bodyPart ? ` (${injury.bodyPart})` : ""
                              }`}
                            >
                              {injury.label}
                            </span>
                          )}
                        </span>
                        <span className="muted text-xs">
                          {positionLabel(player.pos)}
                          {posRank !== undefined && (
                            <span
                              title={`${ordinal(posRank)} best ${player.pos} still on the board`}
                            >
                              {posRank}
                            </span>
                          )}{" "}
                          &middot; {player.team_abbr ?? "FA"}
                          {player.bye_week !== null && (
                            <> &middot; bye {player.bye_week}</>
                          )}
                        </span>
                      </td>
                      <td className="text-right tabular-nums">
                        {player.proj_points === null
                          ? "—"
                          : Number(player.proj_points).toFixed(0)}
                      </td>
                      <td className="muted text-right tabular-nums">
                        {Number(player.total_points).toFixed(0)}
                      </td>
                      <td>
                        <div className="flex gap-1">
                          {myTeamId && (
                            <button
                              type="button"
                              className={`btn btn-sm ${
                                queuedIds.has(player.player_id)
                                  ? "btn-primary"
                                  : ""
                              }`}
                              disabled={pending}
                              onClick={() => toggleQueue(player)}
                              title={
                                queuedIds.has(player.player_id)
                                  ? "Remove from your queue"
                                  : "Add to your queue"
                              }
                            >
                              {queuedIds.has(player.player_id) ? "★" : "☆"}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            disabled={!canPick || pending}
                            onClick={() =>
                              pick(player.player_id, player.full_name)
                            }
                          >
                            Draft
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="space-y-4">
          {myTeamId && (
            <QueuePanel
              queue={queue}
              rounds={draft.rounds}
              currentRound={currentRound}
              canPick={canPick}
              pending={pending}
              strategy={strategy}
              autopickName={autopickName}
              onStrategy={changeStrategy}
              onDraft={pick}
              onMove={moveInQueue}
              onRound={changeRound}
              onRemove={removeFromQueue}
            />
          )}

          <RosterPanel
            teams={teams}
            selectedTeamId={rosterTeamId}
            onSelectTeam={setRosterTeamId}
            myTeamId={myTeamId}
            teamName={rosterTeam?.name ?? ""}
            rosterSlots={rosterSlots}
            picks={picks}
            playerById={playerById}
          />
        </aside>
      </div>
    </div>
  );
}

/** What the pool can be ordered by. */
type PoolSort = "adp" | "projection" | "points";

function ordinal(n: number): string {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/**
 * The board, top to bottom.
 *
 * One row per pick slot, every round, in order -- so the picks already
 * made, the pick on the clock and the picks still to come are one list
 * rather than three panels. It scrolls itself to the current pick as the
 * draft moves, which is the whole reason it is a column: a wide grid
 * cannot follow anything.
 */
function DraftBoard({
  picks,
  teams,
  playerById,
  currentPickNumber,
  myTeamId,
}: {
  picks: DraftPick[];
  teams: Team[];
  playerById: Map<string, PickedPlayer>;
  currentPickNumber: number;
  myTeamId: string | null;
}) {
  const teamById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);
  const scroller = useRef<HTMLDivElement>(null);
  const currentRow = useRef<HTMLLIElement>(null);

  /*
   * Follow the clock.
   *
   * Deliberately not scrollIntoView: that walks up the tree and scrolls
   * every scrollable ancestor, which on a phone drags the whole page
   * about every time somebody picks. Setting scrollTop moves this list
   * and nothing else.
   */
  useEffect(() => {
    const box = scroller.current;
    const row = currentRow.current;
    if (!box || !row) return;

    box.scrollTo({
      top: row.offsetTop - box.clientHeight / 2 + row.clientHeight / 2,
      behavior: "smooth",
    });
  }, [currentPickNumber]);

  if (picks.length === 0) return null;

  const myNext = picks.find(
    (p) => p.team_id === myTeamId && p.pick_number >= currentPickNumber,
  );
  const picksAway = myNext ? myNext.pick_number - currentPickNumber : null;

  return (
    <section className="card-tight lg:sticky lg:top-4 lg:self-start">
      <div className="border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold">Board</h2>
        {picksAway !== null && (
          <p className="muted text-xs">
            {picksAway === 0
              ? "You are on the clock"
              : `Your next pick is ${picksAway} away`}
          </p>
        )}
      </div>

      <div
        ref={scroller}
        className="max-h-[32rem] overflow-y-auto lg:max-h-[calc(100vh-12rem)]"
      >
        <ul className="divide-y divide-border/60">
          {picks.map((pick) => {
            const team = teamById.get(pick.team_id);
            const player = pick.player_id
              ? playerById.get(pick.player_id)
              : null;

            const isCurrent = pick.pick_number === currentPickNumber;
            const isMine = pick.team_id === myTeamId;
            const isUpcoming = pick.pick_number > currentPickNumber;

            return (
              <li
                key={pick.id}
                ref={isCurrent ? currentRow : null}
                className={`flex items-center gap-2 px-3 py-1.5 text-sm ${
                  isCurrent
                    ? "bg-accent/10 ring-1 ring-accent/40 ring-inset"
                    : isMine
                      ? "bg-surface-2/60"
                      : ""
                }`}
              >
                <span
                  aria-hidden
                  className="h-7 w-1 shrink-0 rounded-full"
                  style={{ backgroundColor: team?.color ?? "transparent" }}
                />

                <span className="muted w-9 shrink-0 text-xs tabular-nums">
                  {pick.round}.{String(pick.round_pick).padStart(2, "0")}
                </span>

                <span className="min-w-0 flex-1">
                  {player ? (
                    <>
                      <span className="block truncate font-medium">
                        {player.full_name}
                      </span>
                      <span className="muted block truncate text-xs">
                        {positionLabel(player.position)} &middot;{" "}
                        {team?.abbreviation || team?.name}
                        {pick.is_autopick && " · auto"}
                      </span>
                    </>
                  ) : (
                    <>
                      <span
                        className={`block truncate ${
                          isCurrent ? "font-semibold" : "muted"
                        }`}
                      >
                        {team?.name ?? "—"}
                      </span>
                      <span className="muted block text-xs">
                        {isCurrent
                          ? "on the clock"
                          : isUpcoming
                            ? "upcoming"
                            : "no pick"}
                      </span>
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

/**
 * Your queue, and what happens when you are not looking at it.
 *
 * Three things it does that a starred list does not. You can draft
 * straight out of it, which is the whole point of building one during
 * the rounds before yours. Each entry can name the round it is wanted
 * in: autopick skips anybody whose round has not arrived, so a
 * round-seven sleeper can sit at the top of the queue from round one
 * without any risk of autopick spending a first-rounder on him.
 *
 * And it says, out loud, what autodraft will do -- both the rule and
 * the name it currently resolves to. That used to be guesswork: the
 * fallback was hard-coded to last season's points and nothing in the
 * room admitted it.
 */
function QueuePanel({
  queue,
  rounds,
  currentRound,
  canPick,
  pending,
  strategy,
  autopickName,
  onStrategy,
  onDraft,
  onMove,
  onRound,
  onRemove,
}: {
  queue: QueueEntry[];
  rounds: number;
  currentRound: number;
  canPick: boolean;
  pending: boolean;
  strategy: AutodraftStrategy;
  autopickName: string | null;
  onStrategy: (strategy: AutodraftStrategy) => void;
  onDraft: (playerId: string, name: string) => void;
  onMove: (playerId: string, by: number) => void;
  onRound: (playerId: string, round: number | null) => void;
  onRemove: (playerId: string) => void;
}) {
  // Who autopick would actually take out of the queue, if the clock ran
  // out right now. Null means it falls through to the strategy below.
  const nextUp = queue.find(
    (q) => q.target_round === null || q.target_round <= currentRound,
  );

  return (
    <section className="card-tight">
      <div className="space-y-2 border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold">Autodraft &amp; queue</h2>

        <div>
          <label className="muted text-xs" htmlFor="autodraft-strategy">
            When your queue has nobody due, take
          </label>
          <select
            id="autodraft-strategy"
            className="input mt-1 h-9 py-0 text-sm"
            value={strategy}
            disabled={pending}
            onChange={(e) => onStrategy(e.target.value as AutodraftStrategy)}
          >
            {(
              Object.entries(AUTODRAFT_LABELS) as [AutodraftStrategy, string][]
            ).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <p className="muted text-xs">
          {autopickName ? (
            <>
              Next up: <strong className="text-foreground">{autopickName}</strong>
              {nextUp ? " — from your queue." : " — best available."}
            </>
          ) : queue.length === 0 ? (
            "Star a player to queue him."
          ) : (
            "Nobody is due this round; autodraft takes the best available."
          )}
        </p>
      </div>

      {queue.length > 0 && (
        <ul className="divide-y divide-border/60">
          {queue.map((entry, index) => {
            const due =
              entry.target_round === null || entry.target_round <= currentRound;
            const isNext = nextUp?.player_id === entry.player_id;

            return (
              <li
                key={entry.player_id}
                className={`px-3 py-2 ${isNext ? "bg-accent/5" : ""}`}
              >
                <div className="flex items-start gap-2">
                  <span className="muted w-4 shrink-0 pt-0.5 text-xs tabular-nums">
                    {index + 1}
                  </span>

                  <div className="min-w-0 flex-1">
                    <span
                      className={`block truncate text-sm font-medium ${
                        due ? "" : "opacity-60"
                      }`}
                    >
                      {entry.full_name}
                      {isNext && (
                        <span className="muted ml-2 text-[10px] uppercase tracking-wide">
                          next
                        </span>
                      )}
                    </span>
                    <span className="muted block text-xs">
                      {positionLabel(entry.position)} &middot;{" "}
                      {entry.team_abbr ?? "FA"}
                      {entry.adp !== null &&
                        ` · ADP ${Number(entry.adp).toFixed(1)}`}
                    </span>
                  </div>

                  <div className="flex shrink-0 gap-0.5">
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={index === 0 || pending}
                      onClick={() => onMove(entry.player_id, -1)}
                      aria-label={`Move ${entry.full_name} up`}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={index === queue.length - 1 || pending}
                      onClick={() => onMove(entry.player_id, 1)}
                      aria-label={`Move ${entry.full_name} down`}
                    >
                      ↓
                    </button>
                  </div>
                </div>

                <div className="mt-1.5 flex items-center gap-2 pl-6">
                  <label
                    className="muted text-xs"
                    htmlFor={`round-${entry.player_id}`}
                  >
                    From round
                  </label>
                  <select
                    id={`round-${entry.player_id}`}
                    className="input h-8 w-20 py-0 text-xs"
                    value={entry.target_round ?? ""}
                    disabled={pending}
                    onChange={(e) =>
                      onRound(
                        entry.player_id,
                        e.target.value ? Number(e.target.value) : null,
                      )
                    }
                  >
                    <option value="">Any</option>
                    {Array.from({ length: rounds }, (_, i) => i + 1).map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>

                  <button
                    type="button"
                    className="btn btn-sm btn-primary ml-auto"
                    disabled={!canPick || pending}
                    onClick={() => onDraft(entry.player_id, entry.full_name)}
                  >
                    Draft
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={pending}
                    onClick={() => onRemove(entry.player_id)}
                    aria-label={`Remove ${entry.full_name} from your queue`}
                  >
                    ✕
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * A team's draft so far, laid out as the roster it is becoming.
 *
 * A flat list of picks does not answer the question anybody actually has
 * mid-draft, which is "what am I still short of". Slotting each pick
 * into the league's own roster shape does: the empty rows are the gaps,
 * and the tally across the top says at a glance how many of each
 * position are already in.
 *
 * The team selector is what makes it useful for scouting as well --
 * seeing that the manager picking ahead of you already has two
 * quarterbacks is worth knowing before you reach for your own.
 */
function RosterPanel({
  teams,
  selectedTeamId,
  onSelectTeam,
  myTeamId,
  teamName,
  rosterSlots,
  picks,
  playerById,
}: {
  teams: Team[];
  selectedTeamId: string;
  onSelectTeam: (teamId: string) => void;
  myTeamId: string | null;
  teamName: string;
  rosterSlots: RosterSlot[];
  picks: DraftPick[];
  playerById: Map<string, PickedPlayer>;
}) {
  const filled = useMemo(() => {
    const drafted = picks
      .filter((p) => p.team_id === selectedTeamId && p.player_id)
      .map((p) => playerById.get(p.player_id as string))
      .filter((p): p is PickedPlayer => !!p);

    const slots = expandSlots(rosterSlots);
    const taken = new Set<string>();

    // Slot first, player second. Walking the slots in roster order means
    // a running back fills RB before he is considered for FLEX, so the
    // flex slot ends up holding the spare rather than the starter.
    const rows = slots.map((slot) => {
      const player = drafted.find(
        (p) =>
          !taken.has(p.id) &&
          slotAccepts({ eligible_positions: slot.eligiblePositions }, p.position),
      );
      if (player) taken.add(player.id);
      return { slot, player: player ?? null };
    });

    // How many of each position are in, and how many the league's roster
    // shape has room for. Capacity counts every slot that will take the
    // position, flex included, so "RB 3/5" means three backs against
    // five places a back could sit.
    const counts = new Map<string, number>();
    for (const player of drafted) {
      if (!player.position) continue;
      counts.set(player.position, (counts.get(player.position) ?? 0) + 1);
    }

    const wanted = new Set<string>();
    for (const slot of rosterSlots) {
      for (const p of slot.eligible_positions) wanted.add(p);
    }
    for (const position of counts.keys()) wanted.add(position);

    const tally = [...wanted].sort(byPosition).map((position) => ({
      position,
      held: counts.get(position) ?? 0,
      capacity: rosterSlots.reduce(
        (sum, slot) =>
          slot.eligible_positions.length === 0 ||
          slot.eligible_positions.includes(position)
            ? sum + slot.count
            : sum,
        0,
      ),
    }));

    // Anybody a full roster had no room for still has to be visible.
    const overflow = drafted.filter((p) => !taken.has(p.id));
    return { rows, overflow, tally, count: drafted.length };
  }, [picks, selectedTeamId, playerById, rosterSlots]);

  return (
    <section className="card-tight">
      <div className="space-y-2 border-b border-border px-3 py-2">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">
            {selectedTeamId === myTeamId ? "Your roster" : "Roster"}
          </h2>
          <span className="muted text-xs">{filled.count} picked</span>
        </div>

        <select
          className="input h-9 py-0 text-sm"
          value={selectedTeamId}
          onChange={(e) => onSelectTeam(e.target.value)}
          aria-label="Whose picks to show"
        >
          {teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
              {team.id === myTeamId ? " (you)" : ""}
            </option>
          ))}
        </select>

        {filled.tally.length > 0 && (
          <ul className="flex flex-wrap gap-1">
            {filled.tally.map(({ position, held, capacity }) => (
              <li
                key={position}
                className={`pill ${
                  held === 0
                    ? ""
                    : held >= capacity
                      ? "border-positive text-positive"
                      : "text-foreground"
                }`}
                title={`${held} drafted at ${position}${
                  capacity > 0 ? ` of ${capacity} places` : ""
                }`}
              >
                {positionLabel(position)} {held}
                {capacity > 0 && (
                  <span className="opacity-60">/{capacity}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {filled.rows.length === 0 ? (
        <p className="muted p-3 text-sm">
          {teamName} has no roster shape set.
        </p>
      ) : (
        <ul className="divide-y divide-border/60">
          {filled.rows.map(({ slot, player }) => (
            <li
              key={slot.key}
              className="flex items-center gap-2 px-3 py-1.5 text-sm"
            >
              <span
                className={`w-12 shrink-0 text-xs font-semibold ${
                  slot.isStarter ? "" : "muted"
                }`}
              >
                {slot.label}
              </span>
              {player ? (
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{player.full_name}</span>
                  <span className="muted block truncate text-xs">
                    {positionLabel(player.position)} &middot;{" "}
                    {player.team_abbr ?? "FA"}
                  </span>
                </span>
              ) : (
                <span className="muted flex-1 text-xs">empty</span>
              )}
            </li>
          ))}

          {filled.overflow.map((player) => (
            <li
              key={player.id}
              className="flex items-center gap-2 px-3 py-1.5 text-sm"
            >
              <span className="muted w-12 shrink-0 text-xs font-semibold">
                Extra
              </span>
              <span className="min-w-0 flex-1 truncate">
                {player.full_name}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
