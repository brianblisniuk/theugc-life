/**
 * E02 owns the shell (D081, Accepted). E03 may add routes, and must not add
 * them to the primary navigation.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("primary navigation", () => {
  it("keeps the five primary items and does not add Inbox or Collaborations routes", () => {
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
    expect(shell).toContain("PRIMARY_NAV");
    expect(shell).not.toContain("/app/inbox");
    expect(shell).not.toContain("/app/collaborations");
  });
});
