/**
 * Local environment loading for the evaluation CLI.
 *
 * Uses Node's built-in `process.loadEnvFile` (Node >= 20.12), so no dependency
 * is added for this. The repo already requires Node >= 20.
 *
 * Only `.env.local` is loaded, and only when present — it is the file the repo
 * already gitignores and documents for local secrets. Nothing here reads,
 * prints or returns a value.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const LOCAL_ENV_FILE = ".env.local";

export interface EnvLoadResult {
  /** Whether the file existed and was loaded. */
  loaded: boolean;
  path: string;
  /** Present only when loading was attempted and failed. Never contains values. */
  error?: string;
}

/**
 * Load `.env.local` into `process.env` if it exists.
 *
 * Existing environment variables win: an explicitly exported value should not be
 * silently overridden by a stale file. `loadEnvFile` follows dotenv semantics
 * here, and the behaviour is asserted in tests.
 */
export function loadLocalEnv(cwd: string = process.cwd()): EnvLoadResult {
  const path = resolve(cwd, LOCAL_ENV_FILE);
  if (!existsSync(path)) return { loaded: false, path };

  try {
    process.loadEnvFile(path);
    return { loaded: true, path };
  } catch (error) {
    // Never surface the file's contents in an error message.
    return {
      loaded: false,
      path,
      error: error instanceof Error ? error.message : "unreadable env file",
    };
  }
}
