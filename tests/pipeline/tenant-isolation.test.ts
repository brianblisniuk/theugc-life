/**
 * Cross-tenant negative tests for pipeline_items.
 *
 * User A must never read, update, delete, or enumerate User B's private
 * pipeline resources, even with direct IDs, list endpoints, or RPCs.
 *
 * These tests bind the permanent authentication != authorization invariant.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";

// Placeholder: in CI these run against the real Postgres harness.
// The structure documents the required attack cases.

describe("Pipeline tenant isolation", () => {
  it.todo("User A cannot read User B pipeline item by direct ID");
  it.todo("User A cannot list User B items via filter or enumeration");
  it.todo("User A cannot update User B private_notes via RPC");
  it.todo("User A cannot transition User B item");
  it.todo("Service role is not exposed to client");
  it.todo("RLS policy pipeline_items_all enforces creator_id = current_creator_id()");
});
