import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client. Bypasses RLS entirely.
 *
 * Deliberately kept out of lib/supabase/server.ts: that module imports
 * next/headers, which ties it to a request context and stops the
 * ingestion jobs from running as a plain Node script. This one only
 * needs the two environment variables, so `npm run ingest` works.
 *
 * Never import this from anything that reaches the browser.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set.");
  if (!key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. Add it to .env.local and to " +
        "the Vercel project settings -- the ingestion jobs need it.",
    );
  }

  return createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
