"use client";

import { useState } from "react";

/**
 * Inviting managers.
 *
 * The link carries the join code, so following it adds you to the league
 * and drops you on the team board. The email button is a plain mailto:
 * -- it opens whatever the commissioner already uses rather than making
 * the app into a mail server.
 */
export function InvitePanel({
  origin,
  leagueName,
  joinCode,
  freeTeams,
}: {
  /** Absolute site origin, worked out on the server so the markup
      matches on both sides of hydration. */
  origin: string;
  leagueName: string;
  joinCode: string;
  freeTeams: number;
}) {
  const [copied, setCopied] = useState<"link" | "code" | null>(null);

  const link = `${origin}/join/${joinCode}`;

  async function copy(text: string, which: "link" | "code") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard is blocked on insecure origins and in some browsers;
      // the value is on screen and selectable either way.
    }
  }

  const subject = `Join ${leagueName}`;
  const body = [
    `You're invited to play in ${leagueName}.`,
    "",
    "Follow this link to pick your team:",
    link,
    "",
    `If the link gives you trouble, sign up and enter the code ${joinCode}.`,
  ].join("\n");

  const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  return (
    <section className="card space-y-3">
      <h3 className="h2">Invite managers</h3>
      <p className="muted text-sm">
        {freeTeams === 0
          ? "Every team has a manager."
          : `${freeTeams} team${freeTeams === 1 ? "" : "s"} still free.`}{" "}
        Anyone with this link can join and take one.
      </p>

      <div>
        <label className="label" htmlFor="invite-link">
          Invite link
        </label>
        <div className="flex gap-2">
          <input
            id="invite-link"
            className="input font-mono text-xs"
            readOnly
            value={link}
            onFocus={(e) => e.target.select()}
          />
          <button
            type="button"
            className="btn shrink-0"
            disabled={!link}
            onClick={() => copy(link, "link")}
          >
            {copied === "link" ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div>
          <span className="label">Join code</span>
          <button
            type="button"
            className="btn font-mono"
            onClick={() => copy(joinCode, "code")}
          >
            {copied === "code" ? "Copied" : joinCode}
          </button>
        </div>

        <a className="btn btn-primary" href={mailto}>
          Email an invite
        </a>
      </div>

      <p className="muted text-xs">
        The email button opens your own mail app with the link already
        written, so you can pick the recipients and send it yourself.
      </p>
    </section>
  );
}
