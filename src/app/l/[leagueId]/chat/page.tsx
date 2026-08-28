import { getLeagueContext } from "@/lib/league";
import { createClient } from "@/lib/supabase/server";
import { ChatRoom } from "./chat-room";

export interface ChatMessage {
  id: string;
  user_id: string;
  body: string;
  is_system: boolean;
  created_at: string;
}

export default async function ChatPage({
  params,
}: {
  params: Promise<{ leagueId: string }>;
}) {
  const { leagueId } = await params;
  const { userId } = await getLeagueContext(leagueId);
  const supabase = await createClient();

  const [{ data: messages }, { data: profiles }] = await Promise.all([
    supabase
      .from("league_messages")
      .select("id, user_id, body, is_system, created_at")
      .eq("league_id", leagueId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase.from("profiles").select("id, display_name"),
  ]);

  const names = Object.fromEntries(
    (profiles ?? []).map((p) => [p.id as string, p.display_name as string]),
  );

  return (
    <div className="space-y-4">
      <header>
        <h1 className="h1">League chat</h1>
        <p className="muted">Trash talk and announcements.</p>
      </header>

      <ChatRoom
        leagueId={leagueId}
        userId={userId}
        names={names}
        initialMessages={((messages ?? []) as ChatMessage[]).reverse()}
      />
    </div>
  );
}
