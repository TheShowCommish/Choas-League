"use client";

import { useActionState, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { TeamCrest } from "../team-theme";
import { renameTeam, type LineupResult } from "./actions";

const empty: LineupResult = {};

/** Two megabytes, matching the bucket's own limit. */
const MAX_BYTES = 2 * 1024 * 1024;

export interface TeamIdentity {
  name: string;
  city: string;
  abbreviation: string;
  color: string;
  secondaryColor: string;
  logoUrl: string | null;
}

/**
 * The team's identity, and the Edit button that reveals it.
 *
 * This used to be a collapsed <details> at the very bottom of the page,
 * under the lineup, which is a strange place to keep the controls for
 * the name printed at the top. It now sits where the thing it edits is:
 * next to the team name, opening a panel in place.
 *
 * The colours are a pair rather than one. A single accent can tint a
 * button; two can theme a page, which is what the header wash, the
 * crest and the lineup use them for.
 */
export function TeamSettings({
  leagueId,
  teamId,
  team,
}: {
  leagueId: string;
  teamId: string;
  team: TeamIdentity;
}) {
  const [state, action, pending] = useActionState(renameTeam, empty);
  const [open, setOpen] = useState(false);

  const [color, setColor] = useState(team.color);
  const [secondary, setSecondary] = useState(team.secondaryColor);
  const [logoUrl, setLogoUrl] = useState(team.logoUrl ?? "");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  /*
   * Close on a successful save, so the page underneath -- already
   * repainted in the new colours by the action's revalidate -- is what
   * you are looking at when it finishes.
   *
   * Reconciled during render rather than in an effect, which is both the
   * pattern the draft room already uses and the only one that works
   * here: the result is compared by identity, because two consecutive
   * saves both report the same "Team saved." string and comparing the
   * message would miss the second one.
   */
  const [lastResult, setLastResult] = useState(state);

  if (state !== lastResult) {
    setLastResult(state);
    if (state.ok) setOpen(false);
  }

  /**
   * Uploads straight from the browser to Supabase Storage and puts the
   * resulting public URL in the form. Going through a server action
   * would mean posting the file bytes twice for no benefit.
   *
   * The object path starts with the team id because that is what the
   * bucket's write policy checks.
   */
  async function upload(file: File) {
    setUploadError(null);

    if (file.size > MAX_BYTES) {
      setUploadError("That image is over 2MB. Try a smaller one.");
      return;
    }

    setUploading(true);
    try {
      const supabase = createClient();
      const ext = file.name.split(".").pop()?.toLowerCase() || "png";
      const path = `${teamId}/${crypto.randomUUID()}.${ext}`;

      const { error } = await supabase.storage
        .from("team-logos")
        .upload(path, file, { upsert: true, contentType: file.type });

      if (error) {
        setUploadError(error.message);
        return;
      }

      const { data } = supabase.storage.from("team-logos").getPublicUrl(path);
      setLogoUrl(data.publicUrl);
    } finally {
      setUploading(false);
    }
  }

  /*
   * The button sits inline next to the team name; the panel it opens is
   * an overlay rather than an inline block, so revealing it does not
   * shove the page down and the name stays where it was.
   */
  return (
    <>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => setOpen(true)}
        aria-expanded={open}
      >
        Edit
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/80 p-4 py-10"
          role="dialog"
          aria-modal="true"
          aria-label="Team settings"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="card w-full max-w-2xl space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="h2">Team settings</h2>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setOpen(false)}
              >
                Close
              </button>
            </div>

      <form action={action} className="space-y-4">
        <input type="hidden" name="league_id" value={leagueId} />
        <input type="hidden" name="team_id" value={teamId} />

        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <div>
            <label className="label" htmlFor="team-city">
              City
            </label>
            <input
              id="team-city"
              name="city"
              className="input"
              placeholder="Chicago"
              maxLength={60}
              defaultValue={team.city}
            />
          </div>

          <div>
            <label className="label" htmlFor="team-name">
              Team name
            </label>
            <input
              id="team-name"
              name="name"
              className="input"
              defaultValue={team.name}
              required
            />
          </div>

          <div>
            <label className="label" htmlFor="team-abbr">
              Short
            </label>
            <input
              id="team-abbr"
              name="abbreviation"
              className="input w-24 uppercase"
              maxLength={5}
              placeholder="CHA"
              defaultValue={team.abbreviation}
            />
          </div>
        </div>

        <div>
          <span className="label">Colours</span>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <input
                id="team-color"
                name="color"
                type="color"
                className="input h-10 w-16 p-1"
                value={color}
                onChange={(e) => setColor(e.target.value)}
              />
              <label className="muted text-xs" htmlFor="team-color">
                Main
              </label>
            </div>

            <div className="flex items-center gap-2">
              <input
                id="team-secondary"
                name="secondary_color"
                type="color"
                className="input h-10 w-16 p-1"
                value={secondary}
                onChange={(e) => setSecondary(e.target.value)}
              />
              <label className="muted text-xs" htmlFor="team-secondary">
                Accent
              </label>
            </div>

            <span
              aria-hidden
              className="h-10 min-w-32 flex-1 rounded-md border border-border"
              style={{
                background: `linear-gradient(90deg, ${color}, ${secondary})`,
              }}
            />
          </div>
          <p className="muted mt-1 text-xs">
            These theme your team page: the main colour carries buttons and
            links, the accent carries the header and the crest.
          </p>
        </div>

        <div>
          <span className="label">Logo</span>

          <div className="flex items-center gap-3">
            <TeamCrest
              logoUrl={logoUrl || null}
              abbreviation={team.abbreviation}
              name={team.name}
              color={color}
              secondary={secondary}
            />

            <div className="min-w-0 flex-1 space-y-2">
              <input
                name="logo_url"
                className="input"
                placeholder="https://example.com/logo.png"
                value={logoUrl}
                onChange={(e) => setLogoUrl(e.target.value)}
                aria-label="Logo image link"
              />

              <div className="flex flex-wrap items-center gap-2">
                <label className="btn btn-sm cursor-pointer">
                  {uploading ? "Uploading..." : "Upload an image"}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                    className="hidden"
                    disabled={uploading}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void upload(file);
                      e.target.value = "";
                    }}
                  />
                </label>

                {logoUrl && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setLogoUrl("")}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          </div>

          <p className="muted mt-1 text-xs">
            Paste a link to any image on the web, or upload one (max 2MB). It
            shows in the corner of every page your team appears on.
          </p>
        </div>

        {uploadError && <p className="error-box">{uploadError}</p>}
        {state.error && <p className="error-box">{state.error}</p>}

            <button className="btn btn-primary" disabled={pending || uploading}>
              {pending ? "Saving..." : "Save"}
            </button>
          </form>
          </div>
        </div>
      )}
    </>
  );
}
