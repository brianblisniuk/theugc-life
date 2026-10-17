/**
 * V12.2 fidelity. Icon paths are read from the reference HTML.
 * Contract Review stays out of the product navigation.
 */
import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { V12_ICONS, type V12IconName } from "@/components/icons/v12-icons";
import { SIDEBAR_NAV } from "@/lib/shell/navigation";
import { contrastRatio, meetsAa } from "@/lib/ui/contrast";

function source(file: string): string {
  return readFileSync(file, "utf8");
}

function inner(svg: string): string {
  return svg
    .replace(/<svg[^>]*>/, "")
    .replace(/<\/svg>/, "")
    .replace(/\s+/g, "");
}

function catalog(name: V12IconName): string {
  return V12_ICONS[name]
    .map((node) => {
      if (node.t === "path") return `<path d="${node.d}"/>`;
      if (node.t === "circle") return `<circle cx="${node.cx}" cy="${node.cy}" r="${node.r}"/>`;
      const rx = node.rx ? ` rx="${node.rx}"` : "";
      return `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}"${rx}/>`;
    })
    .join("")
    .replace(/\s+/g, "");
}

const NAV: Record<string, V12IconName> = {
  Home: "home",
  Discover: "discover",
  "My Trips": "trips",
  Outreach: "outreach",
  Pipeline: "pipeline",
  "Pitch Studio": "pitch",
  Inbox: "inbox",
  Collaborations: "collaborations",
  "Contract Review": "contract",
  "My Profile": "profile",
  "Plans & Credits": "plans",
  "Billing & Activity": "billing",
  "Getting Started": "start",
  "UI Guide": "guide",
};

describe("V12.2 icon catalog", () => {
  it("matches every sidebar drawing in home.html", () => {
    const html = source("docs/design/v12.2/home.html");
    const aside = html.match(/<aside[\s\S]*?<\/aside>/)?.[0] ?? "";
    const links = [...aside.matchAll(/<a class="nav-link[^"]*"[\s\S]*?<\/a>/g)];
    expect(links.length).toBeGreaterThan(10);
    for (const link of links) {
      const label = link[0]
        .replace(/<svg[\s\S]*?<\/svg>/, "")
        .replace(/<[^>]+>/g, "")
        .trim();
      const name = NAV[label];
      expect(name, label).toBeTruthy();
      const svg = link[0].match(/<svg[\s\S]*?<\/svg>/)?.[0] ?? "";
      expect(inner(svg)).toBe(catalog(name!));
    }
  });

  it("matches the pitch save and copy drawings", () => {
    const html = source("docs/design/v12.2/pitch.html");
    expect(html.replace(/\s+/g, "")).toContain(catalog("save"));
    expect(html.replace(/\s+/g, "")).toContain(catalog("copy"));
  });

  it("does not put Contract Review in the product nav", () => {
    const labels = SIDEBAR_NAV.flatMap((section) => section.items.map((item) => item.label));
    expect(labels).not.toContain("Contract Review");
    expect(labels).toContain("Pitch Studio");
    expect(source("src/components/shell/app-shell.tsx")).not.toContain('name="contract"');
    expect(source("src/app/(app)/app/collaborations/page.tsx")).not.toContain("Contract Review");
    expect(existsSync("src/app/(app)/app/contracts/page.tsx")).toBe(false);
  });
});

describe("V12.2 shell tokens", () => {
  it("uses the reference topbar, button size, and separated bottom bar", () => {
    const css = source("src/app/midnight.css");
    const globals = source("src/app/globals.css");
    expect(globals).toContain("--topbar: #151d1b");
    expect(css).toMatch(/\.v12-topbar\s*\{[^}]*background:\s*#151d1b/);
    expect(css).toMatch(/\.v12-btn\s*\{[^}]*min-height:\s*39px/);
    expect(css).toMatch(/\.v12-btn\s*\{[^}]*font-size:\s*12px/);
    expect(css).toMatch(/\.v12-btn\s*\{[^}]*background:\s*#151d1b/);
    expect(css).toMatch(/\.v12-bottom\s*\{[^}]*background:\s*#151d1b/);
    expect(globals).toContain("font-size: 14.5px");
    expect(css).toContain("color: #111507");
    expect(meetsAa("#111507", "#D1FF02")).toBe(true);
    expect(meetsAa("#F3FAF4", "#151D1B")).toBe(true);
    expect(contrastRatio("#111507", "#D1FF02")).toBeGreaterThan(7);
  });
});

describe("Pitch Studio entry", () => {
  it("opens the editor with a hotel opportunity picker and does not generate a pitch", () => {
    const page = source("src/app/(app)/app/pitch/page.tsx");
    expect(page).toContain('data-testid="pitch-editor"');
    expect(page).toContain('data-testid="pitch-opportunity-picker"');
    expect(page).toContain("EMAIL COMPOSER");
    expect(page).toContain("opportunityPitchHref");
    expect(page).toContain("A pitch is generated only from a real unlocked hotel");
    expect(page).not.toContain("createPitchPersonalizer");
    expect(page).not.toContain("sendPitchFromGmailAction");
    expect(page).not.toContain("savePitchDraftAction");
    expect(page).not.toContain("draftPitchWithAssistantAction");
  });
});
