/**
 * F02 pitch templates (D110).
 *
 * Substitution is one pass. A missing fact is omitted. A hotel name cannot
 * pull another fact. Copy and mailto do not become a sent pitch.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  FACT_KEYS,
  buildMailto,
  copyText,
  fillTemplate,
  omissionNote,
  pastCollaborationSentence,
  sanitizeMailtoAddress,
  suggestPitch,
  suggestSystemTemplate,
} from "@/lib/pitch/contract";
import { createPitchPersonalizer } from "@/lib/pitch/personalizer";

const ROOT = path.resolve(__dirname, "../..");

function readTree(dir: string): string {
  const abs = path.join(ROOT, dir);
  return readdirSync(abs, { recursive: true })
    .filter((name) => String(name).endsWith(".ts") || String(name).endsWith(".tsx"))
    .map((name) => readFileSync(path.join(abs, String(name)), "utf8"))
    .join("\n");
}

const baseFacts = {
  creator_name: "Ada",
  niche: "food",
  hotel_name: "Casa Luna",
  destination_name: "Lisbon",
};

describe("template personalizer", () => {
  it("uses the template provider when unset and refuses any other name", () => {
    expect(createPitchPersonalizer(undefined)?.provider).toBe("template");
    expect(createPitchPersonalizer("  ")?.provider).toBe("template");
    expect(createPitchPersonalizer("template")?.provider).toBe("template");
    expect(createPitchPersonalizer("openai")).toBeNull();
    expect(createPitchPersonalizer("anthropic")).toBeNull();
  });

  it("omits a missing fact and does not leave a token", () => {
    const draft = suggestPitch({
      facts: baseFacts,
      relationshipStatus: "saved",
    });
    expect(draft.systemKey).toBe("introduction");
    expect(draft.body).toContain("Ada");
    expect(draft.body).toContain("food");
    expect(draft.body).toContain("Casa Luna");
    expect(draft.body).not.toContain("{{");
    expect(draft.body).not.toContain("undefined");
    expect(draft.body).not.toContain("trip");
    expect(draft.used).not.toContain("trip_start");
  });

  it("does not treat saved, planned, won, or closed as a follow-up", () => {
    for (const status of ["saved", "planned", "won", "closed", null]) {
      expect(
        suggestSystemTemplate({
          relationshipStatus: status,
          hasTripDates: false,
          hasConfirmedCollaboration: false,
        }),
      ).toBe("introduction");
    }
    expect(
      suggestSystemTemplate({
        relationshipStatus: "pitched",
        hasTripDates: true,
        hasConfirmedCollaboration: false,
      }),
    ).toBe("follow_up");
    expect(
      suggestSystemTemplate({
        relationshipStatus: "pitched",
        hasTripDates: true,
        hasConfirmedCollaboration: true,
      }),
    ).toBe("return_visit");
  });

  it("mentions a trip only when the dates exist", () => {
    const draft = suggestPitch({
      facts: {
        ...baseFacts,
        trip_start: "2026-11-01",
        trip_end: "2026-11-08",
        trip_name: "Lisbon week",
      },
      relationshipStatus: null,
      systemKey: "stay",
    });
    expect(draft.subject).toContain("2026-11-01");
    expect(draft.body).toContain("Lisbon week");
    expect(draft.body.match(/2026-11-01/g)).toHaveLength(1);
  });

  it("does not invent a stay, a reply rate, or a score", () => {
    expect(pastCollaborationSentence("cancelled", "stay")).toBeNull();
    expect(pastCollaborationSentence("saved", "stay")).toBeNull();
    expect(pastCollaborationSentence("completed", "stay")).toBe(
      "We already have a stay collaboration on record with this hotel.",
    );
    expect(pastCollaborationSentence("completed", "mystery")).toBe(
      "We already have a collaboration on record with this hotel.",
    );
    const draft = suggestPitch({ facts: baseFacts, relationshipStatus: "saved" });
    expect(draft.body.toLowerCase()).not.toContain("reply rate");
    expect(draft.body).not.toContain("0%");
    expect(draft.body.toLowerCase()).not.toContain("most responsive");
    expect(draft.body.toLowerCase()).not.toContain("creator-friendly");
    expect(draft.body).not.toContain("stay collaboration");
  });

  it("does not expand a token hidden inside a hotel name", () => {
    const filled = fillTemplate("{{hotel_name}}", {
      hotel_name: "Casa {{instagram_handle}}",
      instagram_handle: "secret_handle",
    });
    expect(filled.text).not.toContain("secret_handle");
    expect(filled.text).not.toContain("{{instagram_handle}}");
    expect(filled.used).toEqual(["hotel_name"]);
  });

  it("strips an unknown token instead of echoing it", () => {
    const filled = fillTemplate("Hello {{password}} {{creator_name}}", { creator_name: "Ada" });
    expect(filled.text).toBe("Hello Ada");
    expect(filled.text).not.toContain("password");
    expect(filled.used).toEqual(["creator_name"]);
  });

  it("fills a creator template and records only facts that were present", () => {
    const draft = suggestPitch({
      facts: { hotel_name: "Casa Luna" },
      relationshipStatus: null,
      creatorTemplate: {
        subject: "Note for {{hotel_name}}",
        body: "Hi {{contact_name}}. {{hotel_name}}.",
      },
    });
    expect(draft.systemKey).toBeNull();
    expect(draft.subject).toBe("Note for Casa Luna");
    expect(draft.body).not.toContain("{{");
    expect(draft.body).not.toContain("undefined");
    expect(draft.used).toEqual(["hotel_name"]);
  });

  it("says a failed read is not the same as a missing fact", () => {
    const failed = omissionNote({
      facts: baseFacts,
      intelligenceUnavailable: true,
      contactUnchecked: true,
      contactLocked: false,
    });
    expect(failed).toContain("couldn’t be loaded");
    expect(failed).toContain("couldn’t be checked");
    expect(failed).not.toContain("public creator activity");
    expect(failed).not.toContain("contact name");

    const absent = omissionNote({
      facts: { hotel_name: "Casa Luna" },
      intelligenceUnavailable: false,
      contactUnchecked: false,
      contactLocked: true,
    });
    expect(absent).toContain("public creator activity");
    expect(absent).toContain("unlock");
  });
});

describe("mailto and copy", () => {
  it("puts the address on the path and rejects a header injection", () => {
    const href = buildMailto({
      email: "ada@hotel.test",
      subject: "Hello",
      body: "A short note",
    });
    expect(href.startsWith("mailto:ada@hotel.test?")).toBe(true);
    const params = new URLSearchParams(href.slice(href.indexOf("?") + 1));
    expect(params.get("body")).toBe("A short note");
    expect(params.get("body")).not.toContain("ada@hotel.test");
    expect(sanitizeMailtoAddress("ada@hotel.test\nBcc:evil@x.test")).toBe("");
    expect(sanitizeMailtoAddress("not an email")).toBe("");
    expect(
      buildMailto({ email: "ada@hotel.test\r\nBcc:evil@x.test", subject: "Hi", body: "Body" }),
    ).toMatch(/^mailto:\?/);
  });

  it("copy text is the subject and body, with no address appended", () => {
    expect(copyText("Hello", "Body")).toBe("Hello\n\nBody");
    expect(copyText("Hello", "Body")).not.toContain("@");
  });
});

describe("pitch source boundary", () => {
  it("does not name a model vendor, a send API, or pitch_sent", () => {
    const source = [
      readTree("src/lib/pitch"),
      readTree("src/components/pitch"),
      readFileSync(path.join(ROOT, "src/app/(app)/app/hotels/[id]/pitch/page.tsx"), "utf8"),
      readFileSync(path.join(ROOT, "src/app/(app)/app/profile/pitches/page.tsx"), "utf8"),
      readFileSync(path.join(ROOT, "supabase/migrations/0064_pitch_templates.sql"), "utf8"),
    ].join("\n");
    for (const word of [
      "openai",
      "anthropic",
      "googleapis",
      "pitch_sent",
      "outreach_events",
      "resend",
    ]) {
      expect(source.toLowerCase()).not.toContain(word);
    }
  });

  it("keeps the migration allow-list equal to the fact keys", () => {
    const sql = readFileSync(
      path.join(ROOT, "supabase/migrations/0064_pitch_templates.sql"),
      "utf8",
    );
    for (const key of FACT_KEYS) expect(sql).toContain(`'${key}'`);
    expect(sql).not.toContain("'email'");
    expect(sql).not.toContain("'sent'");
  });
});
