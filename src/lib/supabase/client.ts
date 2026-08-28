"use client";

import { createBrowserClient } from "@supabase/ssr";

/**
 * Supabase client for use in client components. Carries the signed-in
 * user's session, so every query runs under that user's RLS policies.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
