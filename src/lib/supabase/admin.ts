import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { WebSocketLikeConstructor } from "@supabase/realtime-js";

import { getClientEnv } from "@/env";
import { serverEnv } from "@/lib/env.server";

/**
 * supabase-js always constructs a Realtime client, and that constructor
 * throws when `globalThis.WebSocket` is missing. Netlify pins Node 20, which
 * has no global WebSocket. These jobs only call `.rpc()`. The stand-in does
 * not open a socket. Node 22 keeps the native constructor.
 */
class InertWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly readyState = 3;
  readonly url: string;
  readonly protocol = "";
  onopen: WebSocket["onopen"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onclose: WebSocket["onclose"] = null;
  onerror: WebSocket["onerror"] = null;

  constructor(address: string | URL, _protocols?: string | string[]) {
    // The realtime URL carries the service-role key in the query. Keep the
    // origin only, so a later socket log cannot repeat it.
    const href = typeof address === "string" ? address : address.href;
    try {
      const parsed = new URL(href);
      parsed.search = "";
      parsed.hash = "";
      this.url = parsed.href;
    } catch {
      this.url = "";
    }
  }

  close(): void {}
  send(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

function realtimeTransport(): WebSocketLikeConstructor | undefined {
  if (typeof globalThis.WebSocket === "function") return undefined;
  return InertWebSocket;
}

/**
 * Service-role Supabase client. BYPASSES Row Level Security.
 *
 * `server-only` ensures this module (and therefore the service-role key) can
 * never be imported into client code. Use ONLY for trusted server operations
 * that legitimately need to bypass RLS:
 *   - payment webhook handlers creating entitlements (PERMISSIONS.md §12)
 *   - controlled admin server jobs / support tooling
 *
 * Never expose its results directly to an unauthorized caller, and never use it
 * to sidestep an authorization check that RLS would otherwise perform for a
 * user-scoped request.
 */
export function createAdminClient() {
  const { NEXT_PUBLIC_SUPABASE_URL } = getClientEnv();
  const { SUPABASE_SERVICE_ROLE_KEY } = serverEnv();

  const transport = realtimeTransport();
  return createSupabaseClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    ...(transport ? { realtime: { transport } } : {}),
  });
}
