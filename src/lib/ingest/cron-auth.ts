import "server-only";

import { NextResponse } from "next/server";

/**
 * Guards the /api/cron routes.
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. These routes
 * run under the service role and bypass RLS, so an unguarded one would
 * let anyone rewrite the league's stats -- if CRON_SECRET is missing we
 * refuse rather than falling open.
 */
export function checkCronAuth(request: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured on the server." },
      { status: 503 },
    );
  }

  const header = request.headers.get("authorization");
  if (header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}

/** Wraps a job so failures come back as JSON rather than a stack trace. */
export async function runJob(
  request: Request,
  job: () => Promise<unknown>,
): Promise<NextResponse> {
  const denied = checkCronAuth(request);
  if (denied) return denied;

  try {
    const result = await job();
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const message = (err as Error).message;
    console.error("Cron job failed:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
