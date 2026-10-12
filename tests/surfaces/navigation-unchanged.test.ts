/**
 * E02 owns navigation. E03 may add routes, and must not add them to the shell.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("primary navigation", () => {
  it("keeps the existing five items and does not add Inbox or Collaborations", () => {
    const nav = readFileSync("src/components/app-nav.tsx", "utf8");
    const layout = readFileSync("src/app/(app)/app/layout.tsx", "utf8");
    expect(nav).toContain('{ href: "/app", label: "Home" }');
    expect(nav).toContain('{ href: "/app/discover", label: "Discover" }');
    expect(nav).toContain('{ href: "/app/pipeline", label: "Pipeline" }');
    expect(nav).toContain('{ href: "/app/trips", label: "Trips" }');
    expect(nav).toContain('{ href: "/app/profile", label: "Profile" }');
    expect(nav).not.toContain("/app/inbox");
    expect(nav).not.toContain("/app/collaborations");
    expect(layout).not.toContain("/app/inbox");
    expect(layout).not.toContain("/app/collaborations");
  });
});
