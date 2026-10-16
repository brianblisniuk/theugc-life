/**
 * D081 keeps the five primary labels. V12.2 draws them in the sidebar and
 * also links the existing Inbox and Collaborations routes. It does not add
 * Contract Review.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("primary navigation", () => {
  it("keeps the five primary labels and lets the sidebar link existing routes", () => {
    const nav = readFileSync("src/lib/shell/navigation.ts", "utf8");
    const shell = readFileSync("src/components/shell/app-shell.tsx", "utf8");
    const primary = nav.slice(
      nav.indexOf("export const PRIMARY_NAV"),
      nav.indexOf("export const UTILITY_NAV"),
    );
    expect(primary).toContain('{ href: "/app", label: "Home" }');
    expect(primary).toContain('{ href: "/app/discover", label: "Discover" }');
    expect(primary).toContain('{ href: "/app/pipeline", label: "Pipeline" }');
    expect(primary).toContain('{ href: "/app/trips", label: "Trips" }');
    expect(primary).toContain('{ href: "/app/profile", label: "Profile" }');
    expect(primary).not.toContain("/app/inbox");
    expect(primary).not.toContain("/app/collaborations");
    expect(primary).not.toContain("surface=");
    expect(shell).toContain("SIDEBAR_NAV");
    expect(shell).toContain("MOBILE_NAV");
    expect(nav).toContain('href: "/app/inbox"');
    expect(nav).toContain('href: "/app/collaborations"');
    expect(shell).not.toContain("Contract Review");
  });
});
