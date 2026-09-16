/**
 * Paths the proxy lets through without a signed-in session.
 *
 * /api/cron is here because GitHub Actions calls it with no cookie. Those
 * routes are not open: every one goes through runJob, which demands
 * `Authorization: Bearer $CRON_SECRET`. Redirecting them to /login made
 * curl see a 307, which it does not count as a failure, so the scheduled
 * jobs reported success without ever running.
 */
export const PUBLIC_PATHS = ["/login", "/signup", "/auth", "/api/cron"];

/** Whether `pathname` is one of PUBLIC_PATHS or beneath one. */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}
