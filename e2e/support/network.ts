import type { BrowserContext } from "@playwright/test";

const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Abort any host that is not this machine. Origins only: no path, no token. */
export async function blockExternalNetwork(context: BrowserContext, hits: string[]): Promise<void> {
  await context.route("**/*", (route) => {
    let host = "";
    try {
      host = new URL(route.request().url()).hostname;
    } catch {
      host = "unparsed";
    }
    if (LOCAL.has(host)) return route.continue();
    hits.push(host);
    return route.abort();
  });
}
