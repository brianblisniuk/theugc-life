import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

import type { BudgetResult, ClaimResult, LookupStore } from "./hunter-lookup";
import type { ContactProviderRaw } from "./types";

/**
 * Service-role cache and budget (D180). The browser never sees these rows.
 * A failed RPC becomes a thrown error so the lookup returns the Error state
 * and does not write a contact.
 */

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function rawOf(value: unknown): ContactProviderRaw | null {
  const row = record(value);
  if (!row || (row.provider !== "hunter" && row.provider !== "fake")) return null;
  if (row.status !== "found" && row.status !== "not_found") return null;
  return row as unknown as ContactProviderRaw;
}

export function createSqlLookupStore(): LookupStore {
  return {
    async claim(cacheKey) {
      const { data, error } = await createAdminClient().rpc("claim_contact_provider_lookup", {
        p_cache_key: cacheKey,
      });
      if (error) throw new Error("contact lookup claim failed");
      const row = record(data);
      if (!row) throw new Error("contact lookup claim failed");
      if (row.outcome === "pending") return { outcome: "pending" };
      if (row.outcome === "claimed") return { outcome: "claimed" };
      if (
        row.outcome === "hit" &&
        (row.status === "found" || row.status === "not_found" || row.status === "unverified")
      ) {
        const hit: ClaimResult = {
          outcome: "hit",
          status: row.status,
          email: typeof row.email === "string" ? row.email : null,
          raw: rawOf(row.raw),
        };
        return hit;
      }
      throw new Error("contact lookup claim failed");
    },
    async complete(cacheKey, status, email, raw) {
      const { error } = await createAdminClient().rpc("complete_contact_provider_lookup", {
        p_cache_key: cacheKey,
        p_status: status,
        p_email: email,
        p_raw: raw,
      });
      if (error) throw new Error("contact lookup complete failed");
    },
    async abandon(cacheKey) {
      const { error } = await createAdminClient().rpc("abandon_contact_provider_lookup", {
        p_cache_key: cacheKey,
      });
      if (error) throw new Error("contact lookup abandon failed");
    },
    async budget(bucket, op) {
      const { data, error } = await createAdminClient().rpc("apply_contact_provider_budget", {
        p_bucket: bucket,
        p_op: op,
      });
      if (error) throw new Error("contact lookup budget failed");
      const row = record(data);
      const used = typeof row?.used === "number" && Number.isFinite(row.used) ? row.used : 0;
      if (row?.outcome === "reserved") return { outcome: "reserved", used } satisfies BudgetResult;
      if (row?.outcome === "exhausted") return { outcome: "exhausted", used };
      if (row?.outcome === "ok") return { outcome: "ok", used };
      throw new Error("contact lookup budget failed");
    },
  };
}
