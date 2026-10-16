import "server-only";

import { findWithHunter, type HunterEnv } from "./hunter-lookup";
import { createSqlLookupStore } from "./hunter-store.server";
import type { ContactProvider } from "./types";

/**
 * Server Hunter adapter (D180).
 *
 * HUNTER_API_KEY is read here and sent only as the X-API-KEY header.
 * HUNTER_DISABLED=true, 1, or yes fails closed before any network call.
 * In test and in CI the default fetch throws, so a forgotten mock cannot
 * reach api.hunter.io.
 */

export function readHunterEnv(env: NodeJS.ProcessEnv = process.env): HunterEnv {
  const flag = (env.HUNTER_DISABLED ?? "").trim().toLowerCase();
  const key = (env.HUNTER_API_KEY ?? "").trim();
  return {
    disabled: flag === "true" || flag === "1" || flag === "yes",
    apiKey: key.length >= 8 ? key : null,
  };
}

function liveFetch(): typeof fetch {
  if (process.env.NODE_ENV === "test" || process.env.CI === "true") {
    return () => Promise.reject(new Error("Hunter must be mocked in tests"));
  }
  return fetch;
}

export function createHunterProvider(): ContactProvider {
  return {
    findHotelEmail(input) {
      return findWithHunter(input, {
        env: readHunterEnv(),
        store: createSqlLookupStore(),
        fetchImpl: liveFetch(),
      });
    },
  };
}
