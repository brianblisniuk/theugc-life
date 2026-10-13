import { bindServerActions } from "@/lib/entitlements/inventory";
import { healthPayload } from "@/lib/http/health";

bindServerActions(["ops.health"]);

export const dynamic = "force-dynamic";

/**
 * Liveness. The body is `{ status: "ok" }` and nothing else.
 * Middleware skips the session lookup on this path.
 */
export function GET() {
  return Response.json(healthPayload(), {
    headers: { "Cache-Control": "no-store" },
  });
}
