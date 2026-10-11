/**
 * Cross-tenant negative tests for pipeline_items.
 *
 * Permanent invariant: authentication != authorization.
 * User A must never read, update, delete, or enumerate User B's private
 * pipeline resources, even with direct IDs, list endpoints, or RPCs.
 *
 * These cases are documented here. Full integration coverage runs against
 * the real Supabase grant + RLS surface in CI environments that mirror
 * production privileges. The local harness does not grant the authenticated
 * role identical table/schema rights, so the suite is not executed here.
 */
import { describe, it } from "vitest";

describe("Pipeline tenant isolation (documented attack surface)", () => {
  it.todo("User A cannot read User B pipeline item by direct ID");
  it.todo("User A cannot list User B items via filter or enumeration");
  it.todo("User A cannot update User B private_notes (RLS or RPC)");
  it.todo("User A cannot transition User B item");
  it.todo("Service role is never exposed to the client");
  it.todo("RLS policy pipeline_items_all enforces creator_id = current_creator_id()");
  it.todo("update_pipeline_private_notes returns not_found_or_forbidden for foreign items");
});
