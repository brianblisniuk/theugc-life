/**
 * Production Discover / Hotel Detail must not reach a demo fixture or a map
 * tile provider. The scan is the source that the production build compiles.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const SCAN_ROOTS = ["src/app", "src/components", "src/lib/hotels", "src/lib/maps"];

const FORBIDDEN = [
  /demoHotels/i,
  /mockHotels/i,
  /SAMPLE_HOTELS/,
  /FIXTURE_HOTELS/,
  /from ["'][^"']*\/tests\//,
  /maps\/api\/staticmap/,
  /maps\/api\/place/,
  /api\.mapbox\.com/,
  /tiles\.mapbox\.com/,
  /tile\.openstreetmap\.org/,
  /basemaps\.cartocdn\.com/,
  /images\.unsplash\.com/,
  /<iframe/i,
];

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full)));
    else if (/\.(ts|tsx|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("no demo fixture in the production discover surface", () => {
  it("ships no demo hotel module, map tile host, or iframe", async () => {
    const files = (
      await Promise.all(SCAN_ROOTS.map((root) => filesUnder(path.join(ROOT, root))))
    ).flat();
    expect(files.length).toBeGreaterThan(10);
    const hits: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const pattern of FORBIDDEN) {
        if (pattern.test(text)) hits.push(`${path.relative(ROOT, file)} matches ${pattern}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("the map module names only the Maps JavaScript API and no hardcoded key", async () => {
    const text = await readFile(path.join(ROOT, "src/lib/maps/google.ts"), "utf8");
    expect(text).toContain("https://maps.googleapis.com");
    expect(text).toContain("/maps/api/js");
    expect(text).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
    expect(text).not.toMatch(/staticmap|maps\/api\/place|api\.mapbox|<iframe/i);
    const component = await readFile(
      path.join(ROOT, "src/components/hotels/hotel-map.tsx"),
      "utf8",
    );
    expect(component).not.toMatch(/https?:\/\//);
    expect(component).not.toMatch(/<iframe/i);
  });

  it("the compiled discover and hotel routes do not embed a demo fixture or tile host", async () => {
    const serverApp = path.join(ROOT, ".next/server/app");
    let present = true;
    try {
      await readdir(serverApp);
    } catch {
      present = false;
    }
    if (!present) return;

    const compiled = (await readdir(serverApp, { recursive: true }))
      .map((entry) => path.join(serverApp, String(entry)))
      .filter((file) => /discover|hotels/.test(file) && file.endsWith(".js"));
    const files = compiled;
    expect(files.length).toBeGreaterThan(0);
    const hits: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const pattern of FORBIDDEN) {
        if (pattern.test(text)) hits.push(`${path.relative(ROOT, file)} matches ${pattern}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
