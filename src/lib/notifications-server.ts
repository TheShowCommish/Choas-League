/**
 * Server side of the notification centre (T-072): reads for the signed-in
 * user, and the write path.
 *
 * Reads run under the user's own session, so RLS already limits them to
 * that user's rows in a league they belong to. Writes go through the
 * notify() RPC under the service role -- a manager can never drop a row
 * into someone else's inbox -- and are best-effort: a failed alert must
 * never break the action that triggered it.
 */
import "server-only";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Notification } from "@/lib/types";
import type { NotificationDraft } from "@/lib/notifications";

/** How many unread alerts the signed-in user has in this league. */
export async function getUnreadCount(leagueId: string): Promise<number> {
  const supabase = await createClient();
  const { count } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("league_id", leagueId)
    .is("read_at", null);
  return count ?? 0;
}

/** The user's most recent alerts in this league, newest first. */
export async function getRecentNotifications(
  leagueId: string,
  limit = 30,
): Promise<Notification[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("notifications")
    .select("*")
    .eq("league_id", leagueId)
    .order("created_at", { ascending: false })
    .limit(limit)
    .overrideTypes<Notification[]>();
  return data ?? [];
}

/**
 * Raise one notification for a recipient. Swallows every failure: the
 * underlying action (the trade, the waiver run, the finalize) has already
 * happened and must not be undone because an alert could not be written.
 */
export async function sendNotification(
  leagueId: string,
  recipientUserId: string,
  draft: NotificationDraft,
  data: Record<string, unknown> | null = null,
): Promise<void> {
  try {
    const admin = createAdminClient();
    await admin.rpc("notify", {
      p_league: leagueId,
      p_recipient: recipientUserId,
      p_type: draft.type,
      p_title: draft.title,
      p_body: draft.body,
      p_link: draft.link,
      p_data: data,
    });
  } catch {
    // best-effort; see the doc comment above.
  }
}
