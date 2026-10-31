/**
 * Copy and links for the in-app notification centre (T-072).
 *
 * Pure: every builder turns the facts already in scope at an event site
 * into the {type, title, body, link} that notify() stores. Kept free of
 * any server import so the event sites and the unit tests can both use
 * it. The server side (reads, mark-read, the notify() call) lives in
 * notifications-server.ts.
 */
import type { NotificationType } from "@/lib/types";

export interface NotificationDraft {
  type: NotificationType;
  title: string;
  body: string;
  link: string;
}

const tradesLink = (leagueId: string) => `/l/${leagueId}/trades`;
const transactionsLink = (leagueId: string) => `/l/${leagueId}/transactions`;
const matchupsLink = (leagueId: string) => `/l/${leagueId}/matchups`;

/** A trade has been offered to you. Goes to the manager being asked. */
export function tradeOfferNotification(
  leagueId: string,
  fromTeamName: string,
): NotificationDraft {
  return {
    type: "trade_offer",
    title: "New trade offer",
    body: `${fromTeamName} has proposed a trade.`,
    link: tradesLink(leagueId),
  };
}

/** Your offer was accepted. Goes to the manager who proposed it. */
export function tradeAcceptedNotification(
  leagueId: string,
  byTeamName: string,
): NotificationDraft {
  return {
    type: "trade_accepted",
    title: "Trade accepted",
    body: `${byTeamName} accepted your trade.`,
    link: tradesLink(leagueId),
  };
}

/**
 * An offer did not go through. `rejected` goes to the proposer (the other
 * manager said no); `withdrawn` goes to the manager it was offered to (the
 * proposer pulled it). The caller picks which, and names the other side.
 */
export function tradeClosedNotification(
  leagueId: string,
  kind: "rejected" | "withdrawn",
  otherTeamName: string,
): NotificationDraft {
  return kind === "rejected"
    ? {
        type: "trade_rejected",
        title: "Trade rejected",
        body: `${otherTeamName} rejected your trade.`,
        link: tradesLink(leagueId),
      }
    : {
        type: "trade_withdrawn",
        title: "Trade withdrawn",
        body: `${otherTeamName} withdrew their trade offer.`,
        link: tradesLink(leagueId),
      };
}

/** You won a waiver claim. Goes to the claiming manager. */
export function waiverWonNotification(
  leagueId: string,
  playerName: string,
  bid: number | null,
): NotificationDraft {
  const cost = bid != null && bid > 0 ? ` for $${bid}` : "";
  return {
    type: "waiver_won",
    title: "Waiver claim won",
    body: `You won ${playerName}${cost}.`,
    link: transactionsLink(leagueId),
  };
}

/**
 * A waiver claim did not land. Only the ones worth flagging (e.g. outbid)
 * should call this -- a claim for a player someone else already grabbed is
 * noise. `reason` is the short result note from processing.
 */
export function waiverLostNotification(
  leagueId: string,
  playerName: string,
  reason: string,
): NotificationDraft {
  const why = reason ? ` (${reason})` : "";
  return {
    type: "waiver_lost",
    title: "Waiver claim lost",
    body: `Your claim for ${playerName} did not go through${why}.`,
    link: transactionsLink(leagueId),
  };
}

/**
 * A matchup went final. Built once per manager: `myScore`/`oppScore` are
 * that manager's totals, `oppName` their opponent (null for a bye week).
 */
export function matchupFinalNotification(
  leagueId: string,
  week: number,
  myScore: number,
  oppScore: number,
  oppName: string | null,
): NotificationDraft {
  const score = `${fmt(myScore)}-${fmt(oppScore)}`;
  const opp = oppName ?? "a bye";

  let outcome: string;
  let verb: string;
  if (oppName === null) {
    outcome = "Bye";
    verb = `Week ${week} is final (${fmt(myScore)}).`;
  } else if (myScore > oppScore) {
    outcome = "W";
    verb = `You beat ${opp} ${score}.`;
  } else if (myScore < oppScore) {
    outcome = "L";
    verb = `You lost to ${opp} ${score}.`;
  } else {
    outcome = "T";
    verb = `You tied ${opp} ${score}.`;
  }

  const vs = oppName === null ? "" : ` ${outcome} vs ${oppName}`;
  return {
    type: "matchup_final",
    title: `Week ${week} final:${vs || " Bye"}`,
    body: verb,
    link: matchupsLink(leagueId),
  };
}

/** Scores show to one decimal, trimming a pointless .0. */
function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
