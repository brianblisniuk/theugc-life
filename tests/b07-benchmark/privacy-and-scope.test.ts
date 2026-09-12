/**
 * B07 benchmark — privacy screen, pricing provenance and scope containment.
 *
 * Acceptance tests covered here: 17 (no real Gmail module is required),
 * 19 (pricing metadata carries provider/source/access date), plus the SCOPE
 * attack the round names explicitly: benchmark code must not become
 * production B07, and no migration 0041 may appear.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PRICE_BOOK, priceBookFor } from "../../scripts/b07-benchmark/config/pricing";
import { ALL_CANDIDATES } from "../../scripts/b07-benchmark/config/candidates";
import {
  VENDOR_SCREEN,
  VENDOR_SCREEN_STANDING_CONCLUSION,
  vendorScreenFor,
} from "../../scripts/b07-benchmark/privacy/vendor-screen";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const BENCH_ROOT = join(REPO_ROOT, "scripts", "b07-benchmark");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

describe("privacy / vendor screen", () => {
  it("covers every non-local provider in the candidate matrix", () => {
    for (const candidate of ALL_CANDIDATES) {
      if (candidate.providerId === "local") continue;
      expect(vendorScreenFor(candidate.providerId), candidate.id).toBeDefined();
    }
  });

  it("every entry records sources, an accessed date and how it was verified", () => {
    for (const entry of VENDOR_SCREEN) {
      expect(entry.official_sources.length).toBeGreaterThan(0);
      for (const source of entry.official_sources) {
        expect(source.url).toMatch(/^https:\/\//);
        expect(source.title.length).toBeGreaterThan(0);
      }
      expect(entry.accessed_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.verification).toBeTruthy();
      expect(entry.open_questions.length).toBeGreaterThan(0);
    }
  });

  it("an unverifiable provider is marked undetermined, never optimistically cleared", () => {
    for (const entry of VENDOR_SCREEN) {
      if (entry.verification === "official_page_fetched") continue;
      // A provider whose official source could not be read must NOT be
      // presented as a private-Gmail candidate on the strength of a summary.
      expect(entry.private_gmail_candidacy).toBe("undetermined_official_source_unreachable");
    }
  });

  it("passing the synthetic screen never authorizes real Gmail processing", () => {
    const text = VENDOR_SCREEN_STANDING_CONCLUSION.join(" ");
    expect(text).toMatch(/DOES NOT authorize real Gmail processing/);
    expect(text).toMatch(/explicit privacy\/vendor approval/);
    for (const entry of VENDOR_SCREEN) {
      expect([
        "potential_private_gmail_candidate_pending_final_approval",
        "blocked_for_private_gmail",
        "undetermined_official_source_unreachable",
      ]).toContain(entry.private_gmail_candidacy);
      // Nothing may be marked as simply approved.
      expect(entry.private_gmail_candidacy).not.toMatch(/approved/);
    }
  });
});

describe("pricing provenance", () => {
  it("19. every price carries a source, a source URL and an accessed date", () => {
    for (const price of PRICE_BOOK) {
      expect(price.source.length).toBeGreaterThan(0);
      expect(price.source_url).toMatch(/^https:\/\//);
      expect(price.accessed_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(price.verification).toBeTruthy();
    }
  });

  it("19b. an unverified price is flagged and yields a visibly absurd zero, not a plausible guess", () => {
    for (const price of PRICE_BOOK) {
      if (price.verification === "published_page_fetched") {
        expect(price.input_usd_per_mtok).toBeGreaterThan(0);
        expect(price.output_usd_per_mtok).toBeGreaterThan(0);
      } else {
        expect(price.input_usd_per_mtok).toBe(0);
        expect(price.output_usd_per_mtok).toBe(0);
        expect(price.notes ?? "").toMatch(/Placeholder/);
      }
    }
  });

  it("every model candidate has a price book entry", () => {
    for (const candidate of ALL_CANDIDATES) {
      if (candidate.providerId === "local") continue;
      expect(priceBookFor(candidate.id), candidate.id).not.toBeNull();
    }
  });
});

describe("scope containment", () => {
  const benchFiles = walk(BENCH_ROOT).filter((f) => f.endsWith(".ts"));

  it("17. the benchmark imports no Gmail, database or application module", () => {
    const forbidden = [
      /from ["'].*\/src\//,
      /from ["']@\//,
      /from ["']pg["']/,
      /from ["']@supabase\//,
      /from ["']googleapis["']/,
      /from ["']google-auth-library["']/,
      /gmail_reply_/,
      /gmail_outreach_/,
      /private\.gmail/,
    ];
    for (const file of benchFiles) {
      const source = readFileSync(file, "utf8");
      // Strip block and line comments: the contract is about what the code
      // DOES, and the comments deliberately discuss B06/B07 table names.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const pattern of forbidden) {
        expect(pattern.test(code), `${file} matched ${pattern}`).toBe(false);
      }
    }
  });

  it("no application source imports the benchmark", () => {
    const srcRoot = join(REPO_ROOT, "src");
    if (!existsSync(srcRoot)) return;
    for (const file of walk(srcRoot)) {
      if (!/\.(ts|tsx)$/.test(file)) continue;
      expect(readFileSync(file, "utf8")).not.toContain("b07-benchmark");
    }
  });

  it("this round creates no migration 0041 and no B07 schema", () => {
    const migrations = join(REPO_ROOT, "supabase", "migrations");
    if (!existsSync(migrations)) return;
    for (const file of readdirSync(migrations)) {
      expect(file.startsWith("0041"), `migration ${file} must not exist in this round`).toBe(false);
      expect(file).not.toMatch(/commercial_meaning/i);
    }
  });

  it("run artifacts are gitignored so raw provider output is never committed", () => {
    const gitignore = readFileSync(join(REPO_ROOT, ".gitignore"), "utf8");
    expect(gitignore).toMatch(/artifacts\/b07-benchmark/);
  });
});
