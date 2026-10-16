/**
 * D182 owns the shell chrome. Pipeline surfaces stay on their query.
 * Outreach and Contract Review are not routes in this block.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("V12.1 shell", () => {
  it("uses the sidebar sections and does not keep the theme toggle", () => {
    const nav = readFileSync("src/lib/shell/navigation.ts", "utf8");
    const shell = readFileSync("src/components/shell/app-shell.tsx", "utf8");
    const layout = readFileSync("src/app/layout.tsx", "utf8");
    expect(nav).toContain("SIDEBAR_SECTIONS");
    expect(nav).toContain('label: "Inbox"');
    expect(nav).toContain('label: "Collaborations"');
    expect(nav).not.toContain("/app/outreach");
    expect(nav).not.toContain("/app/contracts");
    expect(shell).toContain("SIDEBAR_SECTIONS");
    expect(shell).toContain("v12-sidebar");
    expect(shell).toContain("v12-topbar");
    expect(shell).toContain("v12-mobile");
    expect(shell).toContain("BreadcrumbTrail");
    expect(shell).not.toContain("ThemeToggle");
    expect(shell).not.toContain("data-theme");
    expect(layout).not.toContain("data-theme");
    expect(layout).not.toContain("THEME_BOOT_SCRIPT");
    expect(layout).toContain("v12.css");
  });
});
