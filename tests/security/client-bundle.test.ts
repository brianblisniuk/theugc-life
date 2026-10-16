/**
 * Client bundles may name NEXT_PUBLIC_GOOGLE_MAPS_API_KEY.
 * They may not name a server secret, and this test never prints a value.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ALLOWED_PUBLIC_SECRET_NAME, scanClientBundle } from "../../scripts/check-client-secrets";

function fixture(source: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "e05-bundle-"));
  writeFileSync(path.join(dir, "chunk.js"), source);
  return dir;
}

describe("client bundle secret scan", () => {
  it("flags a server secret name and allows the Maps key name", () => {
    const findings = scanClientBundle(
      fixture(
        `const name = "${ALLOWED_PUBLIC_SECRET_NAME}"; const other = "SUPABASE_SERVICE_ROLE_KEY"; const ai = "ANTHROPIC_API_KEY"; const hunter = "HUNTER_API_KEY";`,
      ),
    );
    expect(findings.map((finding) => finding.identifier).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "HUNTER_API_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
    ]);
    expect(JSON.stringify(findings)).not.toContain("GOCSPX-");
  });

  it("flags internal job secret names", () => {
    const findings = scanClientBundle(
      fixture(
        `const a = "GMAIL_DISPATCH_SECRET"; const b = "GMAIL_SYNC_SECRET"; const c = "GMAIL_FOLLOWUP_SECRET"; const d = "ACCOUNT_ERASURE_SECRET"; const e = "CREDIT_PERIOD_SECRET";`,
      ),
    );
    expect(findings.map((finding) => finding.identifier).sort()).toEqual([
      "ACCOUNT_ERASURE_SECRET",
      "CREDIT_PERIOD_SECRET",
      "GMAIL_DISPATCH_SECRET",
      "GMAIL_FOLLOWUP_SECRET",
      "GMAIL_SYNC_SECRET",
    ]);
  });

  it("flags the CI service-role sentinel and an extra forbidden value", () => {
    const extra = "service-role-jwt-value-0123456789";
    const findings = scanClientBundle(
      fixture(`const sentinel = "ci-service-role-key"; const leaked = "${extra}";`),
      [extra],
    );
    expect(findings.map((finding) => finding.identifier).sort()).toEqual([
      "extra_forbidden_value",
      "service_role_sentinel",
    ]);
    expect(JSON.stringify(findings)).not.toContain(extra);
  });

  it("scans .next/static when a build is present", () => {
    const staticDir = path.join(process.cwd(), ".next", "static");
    let findings;
    try {
      findings = scanClientBundle(staticDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        if (process.env.CI) throw new Error(".next/static is missing in CI");
        return;
      }
      throw error;
    }
    expect(findings).toEqual([]);
  });
});
