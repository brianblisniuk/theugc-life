/**
 * Foundation smoke tests (no database). Cover the security-relevant pure logic:
 * route protection, role gating, analytics sanitization, log redaction, and
 * confidence gating. These always run, even without TEST_DATABASE_URL.
 */
import { describe, expect, it } from "vitest";

import { isProtectedPath } from "@/lib/auth/routes";
import { isAdminOrEditor } from "@/lib/auth/roles";
import { sanitizeProperties } from "@/lib/analytics";
import { logger } from "@/lib/logger";
import { confidenceForObservations } from "@/lib/config";

describe("route protection (auth gate)", () => {
  it("protects /app and /admin and their subpaths", () => {
    for (const p of ["/app", "/app/pipeline", "/admin", "/admin/hotels/123"]) {
      expect(isProtectedPath(p)).toBe(true);
    }
  });

  it("does not protect public/auth routes", () => {
    for (const p of ["/", "/login", "/pricing", "/hotels/foo", "/creators/jane"]) {
      expect(isProtectedPath(p)).toBe(false);
    }
  });

  it("does not treat lookalike prefixes as protected", () => {
    expect(isProtectedPath("/application")).toBe(false);
    expect(isProtectedPath("/apps")).toBe(false);
  });
});

describe("role gating", () => {
  it("admin and editor pass; creator does not", () => {
    expect(isAdminOrEditor("admin")).toBe(true);
    expect(isAdminOrEditor("editor")).toBe(true);
    expect(isAdminOrEditor("creator")).toBe(false);
  });
});

describe("analytics sanitization (never leak sensitive payloads)", () => {
  it("strips forbidden keys before dispatch", () => {
    const out = sanitizeProperties({
      hotel_id: "abc",
      plan: "pro",
      email: "leak@example.com",
      private_notes: "secret",
      private_value_amount: 5000,
      negotiation_terms: "confidential",
    });
    expect(out).toEqual({ hotel_id: "abc", plan: "pro" });
    expect(out).not.toHaveProperty("email");
    expect(out).not.toHaveProperty("private_notes");
    expect(out).not.toHaveProperty("private_value_amount");
    expect(out).not.toHaveProperty("negotiation_terms");
  });
});

describe("log redaction (no secrets/PII in logs)", () => {
  it("redacts sensitive keys recursively", () => {
    const redacted = logger._redact({
      userId: "u1",
      email: "a@b.com",
      auth: { access_token: "tok", note: "private" },
      pipeline: { private_notes: "secret", status: "pitched" },
    }) as Record<string, unknown>;

    expect(redacted.userId).toBe("u1");
    expect(redacted.email).toBe("[redacted]");
    const auth = redacted.auth as Record<string, unknown>;
    expect(auth.access_token).toBe("[redacted]");
    expect(auth.note).toBe("[redacted]");
    const pipeline = redacted.pipeline as Record<string, unknown>;
    expect(pipeline.private_notes).toBe("[redacted]");
    expect(pipeline.status).toBe("pitched");
  });
});

describe("confidence gating (PRD §12.6)", () => {
  it("maps observation counts to bands", () => {
    expect(confidenceForObservations(0)).toBe("insufficient");
    expect(confidenceForObservations(4)).toBe("insufficient");
    expect(confidenceForObservations(5)).toBe("emerging");
    expect(confidenceForObservations(14)).toBe("emerging");
    expect(confidenceForObservations(15)).toBe("moderate");
    expect(confidenceForObservations(49)).toBe("moderate");
    expect(confidenceForObservations(50)).toBe("strong");
    expect(confidenceForObservations(1000)).toBe("strong");
  });
});
