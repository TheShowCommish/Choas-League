"use client";

import { useActionState, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { renameTeam, type LineupResult } from "./actions";

const empty: LineupResult = {};

/** Two megabytes, matching the bucket's own limit. */
const MAX_BYTES = 2 * 1024 * 1024;

export function TeamNameForm({
  leagueId,
  teamId,
  currentName,
  currentAbbreviation,
  currentColor,
  currentLogoUrl,
}: {
  leagueId: string;
  teamId: string;
  currentName: string;
  currentAbbreviation: string;
  currentColor: string;
  currentLogoUrl: string | null;
}) {
  const [state, action, pending] = useActionState(renameTeam, empty);

  const [color, setColor] = useState(currentColor);
  const [logoUrl, setLogoUrl] = useState(currentLogoUrl ?? "");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

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

  return (
    <details className="card">
      <summary className="cursor-pointer text-sm font-medium">
        Team settings
      </summary>

      <form action={action} className="mt-4 space-y-4">
        <input type="hidden" name="league_id" value={leagueId} />
        <input type="hidden" name="team_id" value={teamId} />

        <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
          <div>
            <label className="label" htmlFor="team-name">
              Team name
            </label>
            <input
              id="team-name"
              name="name"
              className="input"
              defaultValue={currentName}
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
              defaultValue={currentAbbreviation}
            />
          </div>

          <div>
            <label className="label" htmlFor="team-color">
              Colour
            </label>
            <input
              id="team-color"
              name="color"
              type="color"
              className="input h-10 w-16 p-1"
              value={color}
              onChange={(e) => setColor(e.target.value)}
            />
          </div>
        </div>

        <div>
          <span className="label">Logo</span>

          <div className="flex items-center gap-3">
            {logoUrl ? (
              // A logo can be any URL the manager pastes, so this cannot
              // go through next/image -- the host is not known ahead of
              // time and would have to be allow-listed.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoUrl}
                alt=""
                className="size-14 shrink-0 rounded-lg border border-border object-cover"
                style={{ backgroundColor: color }}
              />
            ) : (
              <span
                className="flex size-14 shrink-0 items-center justify-center rounded-lg border border-border text-sm font-semibold"
                style={{ backgroundColor: color }}
              >
                {(currentAbbreviation || currentName.slice(0, 3)).toUpperCase()}
              </span>
            )}

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
            Paste a link to any image on the web, or upload one (max 2MB).
          </p>
        </div>

        {uploadError && <p className="error-box">{uploadError}</p>}
        {state.error && <p className="error-box">{state.error}</p>}
        {state.ok && <p className="ok-box">{state.ok}</p>}

        <button className="btn btn-primary" disabled={pending || uploading}>
          {pending ? "Saving..." : "Save"}
        </button>
      </form>
    </details>
  );
}
