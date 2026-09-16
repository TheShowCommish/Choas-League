/**
 * Which paths the proxy lets through signed out.
 *
 * The cron routes must be among them: a redirect to /login is a 3xx,
 * which the scheduled jobs' curl did not treat as failure, so every job
 * "succeeded" without running.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isPublicPath } from "../src/lib/public-paths.ts";

describe("proxy public paths", () => {
  test("every cron route is reachable without a session", () => {
    for (const job of [
      "finalize-weeks",
      "sync-stats",
      "sync-games",
      "live-scores",
      "lock-lineups",
      "process-waivers",
    ]) {
      assert.equal(isPublicPath(`/api/cron/${job}`), true, job);
    }
  });

  test("the sign-in pages stay public", () => {
    for (const path of ["/login", "/signup", "/auth/signout"]) {
      assert.equal(isPublicPath(path), true, path);
    }
  });

  test("everything else still needs a session", () => {
    for (const path of ["/", "/leagues", "/l/abc/admin", "/api/other", "/api/cronjob", "/authors"]) {
      assert.equal(isPublicPath(path), false, path);
    }
  });
});
