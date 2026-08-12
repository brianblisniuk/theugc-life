import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Vitest configuration.
 *
 * - Node environment: Sprint 0 tests are server/database oriented (RLS policy
 *   tests + auth-guard unit tests). No jsdom needed yet.
 * - `TEST_DATABASE_URL` gates the RLS suite. When it is absent the RLS tests
 *   skip with a clear message (see tests/db/harness.ts) so `npm test` still runs
 *   the non-database suites for contributors without a local Postgres. CI always
 *   sets it.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
    pool: "forks",
    poolOptions: {
      // RLS tests mutate shared database roles/sessions; run serially.
      forks: { singleFork: true },
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws outside a React Server context; stub it for tests.
      "server-only": fileURLToPath(new URL("./tests/stubs/empty.ts", import.meta.url)),
    },
  },
});
