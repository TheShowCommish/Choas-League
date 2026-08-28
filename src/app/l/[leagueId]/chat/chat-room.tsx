"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { ChatMessage } from "./page";

/**
 * Messages arrive over a Supabase realtime subscription, so the board
 * updates without a refresh. Posting goes through the normal insert
 * path; the RLS policy pins user_id to the sender and blocks anyone
 * from faking a system message.
 */
export function ChatRoom({
  leagueId,
  userId,
  names,
  initialMessages,
}: {
  leagueId: string;
  userId: string;
  names: Record<string, string>;
  initialMessages: ChatMessage[];
}) {
  const [messages, setMessages] = useState(initialMessages);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`league-chat-${leagueId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "league_messages",
          filter: `league_id=eq.${leagueId}`,
        },
        (payload) => {
          const message = payload.new as ChatMessage;
          setMessages((prev) =>
            // The sender already appended it optimistically.
            prev.some((m) => m.id === message.id) ? prev : [...prev, message],
          );
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [leagueId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = body.trim();
    if (!text) return;

    setSending(true);
    setError(null);

    const supabase = createClient();
    const { data, error } = await supabase
      .from("league_messages")
      .insert({ league_id: leagueId, user_id: userId, body: text })
      .select("id, user_id, body, is_system, created_at")
      .single();

    if (error) {
      setError(error.message);
    } else {
      setBody("");
      setMessages((prev) =>
        prev.some((m) => m.id === data.id)
          ? prev
          : [...prev, data as ChatMessage],
      );
    }
    setSending(false);
  }

  return (
    <div className="space-y-3">
      <div className="card-tight max-h-[60vh] space-y-3 overflow-y-auto p-3">
        {messages.length === 0 && (
          <p className="muted text-sm">Nothing said yet. Go on.</p>
        )}

        {messages.map((message) => (
          <div key={message.id}>
            {message.is_system ? (
              <p className="muted text-center text-xs italic">{message.body}</p>
            ) : (
              <div
                className={message.user_id === userId ? "text-right" : ""}
              >
                <p className="muted text-xs">
                  {names[message.user_id] ?? "Someone"} &middot;{" "}
                  {new Date(message.created_at).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </p>
                <p
                  className={`inline-block max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                    message.user_id === userId
                      ? "bg-accent text-white"
                      : "bg-surface-2"
                  }`}
                >
                  {message.body}
                </p>
              </div>
            )}
          </div>
        ))}

        <div ref={bottomRef} />
      </div>

      {error && <p className="error-box">{error}</p>}

      <form onSubmit={send} className="flex gap-2">
        <input
          className="input"
          placeholder="Say something"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={4000}
          aria-label="Message"
        />
        <button className="btn btn-primary" disabled={sending || !body.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
