/**
 * SUPABASE_SERVICE_ROLE_KEY may be read by server modules.
 * Client components, modules they bundle, and NEXT_PUBLIC_ variables may not
 * name it. Findings never include a secret value.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { scanServiceRoleReferences } from "../../scripts/check-client-secrets";

function project(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "e05-service-role-"));
  for (const [name, source] of Object.entries(files)) {
    const full = path.join(root, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, source);
  }
  return root;
}

describe("service role key is not a client or NEXT_PUBLIC reference", () => {
  it("flags the name inside a client component", () => {
    const root = project({
      "src/widget.tsx": `"use client";\nexport const label = "SUPABASE_SERVICE_ROLE_KEY";\n`,
    });
    expect(scanServiceRoleReferences(root).map((finding) => finding.reason)).toEqual([
      "client_component",
    ]);
  });

  it("flags a module a client component bundles", () => {
    const root = project({
      "src/widget.tsx": `"use client";\nimport { leak } from "./leak";\nexport const Widget = leak;\n`,
      "src/leak.ts": `export const leak = "SUPABASE_SERVICE_ROLE_KEY";\n`,
    });
    expect(scanServiceRoleReferences(root).map((finding) => finding.reason)).toEqual(["client_import"]);
  });

  it("allows the key behind a server-action boundary and in a server module", () => {
    const root = project({
      "src/widget.tsx": `"use client";\nimport { save } from "./actions";\nexport const Widget = save;\n`,
      "src/actions.ts": `"use server";\nimport { key } from "./secret";\nexport async function save() { return key; }\n`,
      "src/secret.ts": `export const key = process.env.SUPABASE_SERVICE_ROLE_KEY;\n`,
      "src/lib/supabase/admin.ts": `import "server-only";\nexport function createAdminClient() {\n  const { NEXT_PUBLIC_SUPABASE_URL } = getClientEnv();\n  const { SUPABASE_SERVICE_ROLE_KEY } = serverEnv();\n  return createSupabaseClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {});\n}\n`,
    });
    expect(scanServiceRoleReferences(root)).toEqual([]);
  });

  it("flags a NEXT_PUBLIC_ name and an assignment from the service role key", () => {
    const root = project({
      "src/env.ts": `export const env = {\n  NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY,\n  NEXT_PUBLIC_SITE_URL: process.env.SUPABASE_SERVICE_ROLE_KEY,\n};\n`,
      ".env.example": `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY="not-a-value"\nSUPABASE_SERVICE_ROLE_KEY="server-only"\n`,
    });
    const reasons = scanServiceRoleReferences(root)
      .map((finding) => finding.reason)
      .sort();
    expect(reasons).toEqual(["client_env", "next_public_assignment", "next_public_name", "next_public_name"]);
  });

  it("finds no client or NEXT_PUBLIC reference in this repository", () => {
    const findings = scanServiceRoleReferences(process.cwd());
    expect(findings).toEqual([]);
    expect(JSON.stringify(findings)).not.toContain("eyJ");
  });
});
