/**
 * V12.2 Midnight foundation.
 * Contrast is computed. Shell structure is read from source. No browser.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SIDEBAR_NAV } from "@/lib/shell/navigation";
import { contrastRatio, meetsAa } from "@/lib/ui/contrast";

function source(file: string): string {
  return readFileSync(file, "utf8");
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (name.endsWith(".tsx") || name.endsWith(".css")) out.push(full);
  }
  return out;
}

describe("Midnight accent contrast", () => {
  it("keeps dark text on #D1FF02 and light text on the canvas at AA", () => {
    expect(meetsAa("#111507", "#D1FF02")).toBe(true);
    expect(meetsAa("#111507", "#B9E700")).toBe(true);
    expect(contrastRatio("#111507", "#D1FF02")).toBeGreaterThan(7);
    expect(meetsAa("#F5F8F6", "#0C1110")).toBe(true);
    expect(meetsAa("#C7D0CC", "#0C1110")).toBe(true);
    expect(meetsAa("#C7D0CC", "#121918")).toBe(true);
    expect(meetsAa("#C7D0CC", "#151D1B")).toBe(true);
    expect(meetsAa("#C5D2CA", "#0A0E0D")).toBe(true);
    expect(meetsAa("#93A19B", "#0C1110")).toBe(true);
    expect(meetsAa("#A5F0C0", "#163429")).toBe(true);
    expect(meetsAa("#FFD89E", "#3B2E1D")).toBe(true);
    expect(meetsAa("#BBE8FF", "#17313D")).toBe(true);
    expect(meetsAa("#FFB7B7", "#391F23")).toBe(true);
    expect(meetsAa("#E5FF8C", "#2B3914")).toBe(true);
  });

  it("never pairs an accent fill with white text", () => {
    const pair = /(?:bg-accent[^"'`]*text-white|text-white[^"'`]*bg-accent)/;
    const offenders = sourceFiles("src").filter((file) => pair.test(source(file)));
    expect(offenders).toEqual([]);
  });
});

describe("Midnight shell", () => {
  it("has sidebar, top bar, breadcrumbs, and a mobile bottom bar, with no theme toggle", () => {
    const shell = source("src/components/shell/app-shell.tsx");
    const css = source("src/app/midnight.css");
    expect(shell).toContain('aria-label="Main navigation"');
    expect(shell).toContain("v12-topbar");
    expect(shell).toContain('aria-label="Breadcrumb"');
    expect(shell).toContain('aria-label="Quick navigation"');
    expect(shell).toContain("fallback={null}");
    expect(shell.match(/<ShellBody/g)).toHaveLength(1);
    const fallbackAt = shell.indexOf("fallback=");
    const shellBodyAt = shell.indexOf("<ShellBody");
    expect(shellBodyAt).toBeGreaterThan(fallbackAt);
    expect(shell.slice(fallbackAt, shellBodyAt)).not.toContain("{children}");
    expect(shell).not.toContain("ThemeToggle");
    expect(shell).not.toContain("contracts.html");
    expect(css).toContain("@media (max-width: 760px)");
    expect(css).toContain("@media (max-width: 530px)");
    expect(css).toContain("overflow-x: clip");
    expect(css).toContain(".v12-bottom");
    expect(css).not.toMatch(/header nav\[aria-label="Breadcrumb"\]\s*\{[^}]*display:\s*none/);
    expect(existsSync("src/components/theme/theme-toggle.tsx")).toBe(false);
    expect(existsSync("src/lib/ux02/theme.ts")).toBe(false);
    expect(existsSync("src/app/(app)/app/contracts/page.tsx")).toBe(false);
  });

  it("does not link Outreach, Plans, or Contract Review until those screens exist", () => {
    const labels = SIDEBAR_NAV.flatMap((section) => section.items.map((item) => item.label));
    expect(labels).toEqual([
      "Home",
      "Discover",
      "My Trips",
      "Pipeline",
      "Pitch Studio",
      "Inbox",
      "Collaborations",
      "My Profile",
      "Billing & Activity",
      "Getting Started",
      "Account",
    ]);
    expect(labels.join(" ")).not.toMatch(/Contract Review|Outreach|Plans & Credits/);
  });
});

describe("required states and source badges", () => {
  it("names Locked, credits, disconnected email, insufficient data, and both sources", () => {
    const states = source("src/components/ui/states.tsx");
    const badges = source("src/components/ui/badge.tsx");
    expect(states).toContain("Locked");
    expect(states).toContain("Insufficient credits");
    expect(states).toContain("Disconnected email");
    expect(states).toContain("Insufficient data");
    expect(states).toContain('role="alert"');
    expect(states).toContain('aria-busy="true"');
    expect(badges).toContain("Verified via Gmail");
    expect(badges).toContain("Manually recorded");
    expect(source("src/app/(app)/app/design/page.tsx")).toContain("SourceBadge");
    expect(source("src/app/(app)/app/design/page.tsx")).toContain(
      'requireRole(["admin", "editor"], "/app/design")',
    );
    const shell = source("src/components/shell/app-shell.tsx");
    const staff = shell.slice(shell.indexOf("isStaff ?"));
    expect(staff).toContain('href="/app/design"');
    expect(shell.slice(0, shell.indexOf("isStaff ?"))).not.toContain('href="/app/design"');
  });
});
