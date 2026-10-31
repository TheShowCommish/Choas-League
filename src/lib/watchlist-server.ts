/**
 * Server-side reads for the player watchlist (T-074).
 *
 * These run under the user's own session, so RLS (0045) already limits
 * every row to that user's stars in a league they belong to. Kept out of
 * the "use server" actions module so they are not exposed as POST
 * endpoints -- same split as notifications-server.ts. The watchlist view's
 * extra context (availability, next opponent) is read from the same tables
 * the Players tab and player page use, never a change to the pool RPC.
 */
import "server-only";

import { createClient } from "@/lib/supabase/server";
import { watchAvailability } from "@/lib/watchlist";
import type { Watchlist, WatchlistEntry } from "@/lib/types";

/**
 * The set of player ids the signed-in user is watching in this league --
 * what the Players tab needs to render a filled or empty star per row
 * without the pool RPC knowing anything about watchlists. Returned as a
 * plain array (the caller builds the Set); empty on any failure.
 */
export async function getWatchedPlayerIds(leagueId: string): Promise<string[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("player_watchlist")
    .select("player_id")
    .eq("league_id", leagueId);
  return (data ?? []).map((r) => r.player_id as string);
}

/**
 * The user's watchlist for this league, newest star first, each with the
 * context the view shows: identity, availability (owned / waivers / FA)
 * and next-week opponent. Reuses the player page's per-player reads --
 * roster for the owner, player_on_waivers for the waiver window, the
 * weekly projection for the fixture -- so the numbers line up with the
 * rest of the app.
 */
export async function getWatchlist(
  leagueId: string,
  userId: string,
): Promise<Watchlist> {
  const supabase = await createClient();

  const { data: stars } = await supabase
    .from("player_watchlist")
    .select("player_id, created_at")
    .eq("league_id", leagueId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  const rows = (stars ?? []) as { player_id: string; created_at: string }[];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.player_id);

  const { data: league } = await supabase
    .from("leagues")
    .select("season, current_week")
    .eq("id", leagueId)
    .maybeSingle();
  const season = league?.season ?? null;
  const week = league?.current_week ?? null;

  const [{ data: players }, { data: owners }, { data: projections }, onWaivers] =
    await Promise.all([
      supabase
        .from("nfl_players")
        .select("id, full_name, position, team_abbr, headshot_url")
        .in("id", ids),
      supabase
        .from("roster_players")
        .select("player_id, teams(name)")
        .eq("league_id", leagueId)
        .is("dropped_at", null)
        .in("player_id", ids),
      season != null && week != null
        ? supabase
            .from("player_week_projections")
            .select("player_id, opponent")
            .eq("season", season)
            .eq("week", week)
            .in("player_id", ids)
        : Promise.resolve({ data: [] }),
      // player_on_waivers is the authoritative waiver-window check (0042);
      // best-effort per player, false on any failure. Watchlists are small.
      Promise.all(
        ids.map((id) =>
          supabase
            .rpc("player_on_waivers", { p_league: leagueId, p_player: id })
            .then((r) => [id, r.error ? false : Boolean(r.data)] as const),
        ),
      ),
    ]);

  const byId = new Map(
    ((players ?? []) as {
      id: string;
      full_name: string;
      position: string | null;
      team_abbr: string | null;
      headshot_url: string | null;
    }[]).map((p) => [p.id, p] as const),
  );

  const ownerById = new Map(
    ((owners ?? []) as {
      player_id: string;
      teams: { name: string } | { name: string }[] | null;
    }[]).map((o) => {
      const team = Array.isArray(o.teams) ? o.teams[0] : o.teams;
      return [o.player_id, team?.name ?? null] as const;
    }),
  );

  const opponentById = new Map(
    ((projections ?? []) as { player_id: string; opponent: string | null }[]).map(
      (p) => [p.player_id, p.opponent ?? null] as const,
    ),
  );

  const waiversById = new Map(onWaivers);

  const entries: WatchlistEntry[] = [];
  for (const star of rows) {
    const p = byId.get(star.player_id);
    if (!p) continue; // a player row that vanished under us.
    const ownerName = ownerById.get(star.player_id) ?? null;
    entries.push({
      playerId: p.id,
      fullName: p.full_name,
      pos: p.position,
      teamAbbr: p.team_abbr,
      headshotUrl: p.headshot_url,
      availability: watchAvailability(
        ownerName,
        waiversById.get(star.player_id) ?? false,
      ),
      ownerName,
      nextOpponent: opponentById.get(star.player_id) ?? null,
      createdAt: star.created_at,
    });
  }

  return entries;
}
