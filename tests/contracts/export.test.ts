/**
 * D114. The export keeps the not-legal-advice sentence, and this block does
 * not call an e-sign vendor, a mailer, or a model.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { agreementExportText, NOT_LEGAL_ADVICE, TO_BE_FILLED_IN } from "@/lib/contracts/text";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("agreement export", () => {
  it("keeps the not-legal-advice sentence when the body already has it", () => {
    const body = `${NOT_LEGAL_ADVICE}\n\nHotel: Harbor`;
    const text = agreementExportText("Paid collaboration", body);
    expect(text.startsWith("Paid collaboration\n\n")).toBe(true);
    expect(text.split(NOT_LEGAL_ADVICE)).toHaveLength(2);
  });

  it("puts the sentence back when an edited body dropped it", () => {
    const text = agreementExportText("Draft", "Hotel: Harbor");
    expect(text).toContain(NOT_LEGAL_ADVICE);
    expect(text).toContain("Hotel: Harbor");
  });

  it("does not invent a title", () => {
    expect(agreementExportText("   ", "Hotel: Harbor")).toBe(
      `${NOT_LEGAL_ADVICE}\n\nHotel: Harbor`,
    );
  });
});

describe("contract block stays inside the product", () => {
  const files = [
    "supabase/migrations/0068_collaboration_contract_templates.sql",
    "src/lib/contracts/actions.ts",
    "src/lib/contracts/queries.ts",
    "src/lib/contracts/text.ts",
    "src/components/pipeline/contract-drafts.tsx",
  ];

  it("says the template is not legal advice and marks a missing fact", () => {
    const migration = readFileSync(
      path.join(ROOT, "supabase/migrations/0068_collaboration_contract_templates.sql"),
      "utf8",
    );
    expect(migration).toContain(NOT_LEGAL_ADVICE);
    expect(migration).toContain(TO_BE_FILLED_IN);
    expect(migration).not.toContain("private_value_amount");
  });

  it("does not name an e-sign vendor, a mailer, or a model", () => {
    const banned = [
      "docusign",
      "hellosign",
      "dropbox sign",
      "openai",
      "anthropic",
      "resend",
      "sendgrid",
      "gmail.googleapis",
    ];
    for (const file of files) {
      const source = readFileSync(path.join(ROOT, file), "utf8").toLowerCase();
      for (const word of banned) {
        expect(source, `${file} mentions ${word}`).not.toContain(word);
      }
    }
  });
});
