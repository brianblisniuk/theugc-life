import { readFileSync } from "node:fs";
import { createElement } from "react";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MetricRing } from "@/components/design-system/metric-ring";
import { ProvenanceBadge } from "@/components/design-system/provenance-badge";
import { StateMessage } from "@/components/design-system/state-message";
import { contrastRatio, WCAG_AA_NORMAL } from "@/lib/design-system/contrast";
import { metricRingLabel } from "@/lib/design-system/metric-ring";
import { MANDATORY_STATES, PROVENANCE_BADGES, readsAsFakeZero } from "@/lib/design-system/states";
import { V12_LIME_ON_CANVAS, V12_LIME_ON_PAPER, V12_TEXT_PAIRS } from "@/lib/design-system/tokens";

describe("V12.1 contrast", () => {
  it("clears WCAG AA for the text pairs the components paint", () => {
    for (const pair of V12_TEXT_PAIRS) {
      const ratio = contrastRatio(pair.fg, pair.bg);
      expect(ratio, pair.name).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
    }
  });

  it("keeps lime off the light canvas as a text color", () => {
    expect(contrastRatio(V12_LIME_ON_CANVAS.fg, V12_LIME_ON_CANVAS.bg)).toBeLessThan(2);
    expect(contrastRatio(V12_LIME_ON_PAPER.fg, V12_LIME_ON_PAPER.bg)).toBeLessThan(2);
    const css = readFileSync("src/app/v12.css", "utf8");
    const motto = css.slice(css.indexOf(".v12-motto"), css.indexOf(".v12-maincol"));
    expect(motto).toContain("color: var(--lime)");
    const canvasText = css.slice(css.indexOf(".v12-content"), css.indexOf(".v12-crumbs"));
    expect(canvasText).not.toContain("color: var(--lime)");
  });
});

describe("mandatory states and provenance", () => {
  it("names every required state and never calls missing evidence 0%", () => {
    expect(MANDATORY_STATES.map((state) => state.id)).toEqual([
      "loading",
      "empty",
      "insufficient-data",
      "locked",
      "insufficient-credits",
      "success",
      "partial-success",
      "failed",
      "saved",
      "unsaved",
      "verification-pending",
      "access-changed",
      "disconnected-email",
      "manual-only",
    ]);
    for (const state of MANDATORY_STATES) {
      expect(readsAsFakeZero(`${state.title} ${state.body}`)).toBe(false);
      const html = renderToStaticMarkup(createElement(StateMessage, { id: state.id }));
      expect(html).toContain(state.title);
      expect(html).not.toMatch(/0\s*%/);
      expect(html).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      if (state.id === "failed") {
        expect(html).toContain("Retry");
        expect(html).toContain('type="button"');
        expect(html).not.toContain("formAction");
      }
      if (state.id === "locked") {
        expect(html.toLowerCase()).not.toContain("mailto:");
      }
      if (state.id === "manual-only") {
        expect(html.toLowerCase()).toContain("nothing on this screen sends mail");
      }
    }
  });

  it("shows the four provenance labels and an insufficient ring that is not 0%", () => {
    expect(PROVENANCE_BADGES.map((badge) => badge.label)).toEqual([
      "Verified via Gmail",
      "Manually recorded",
      "Sample only",
      "Verification pending",
    ]);
    for (const badge of PROVENANCE_BADGES) {
      const html = renderToStaticMarkup(createElement(ProvenanceBadge, { id: badge.id }));
      expect(html).toContain(badge.label);
    }
    expect(metricRingLabel({ sufficient: false, value: 0, label: "x" })).toBe("Insufficient data");
    expect(metricRingLabel({ sufficient: false, value: 42, label: "x" })).not.toContain("%");
    expect(metricRingLabel({ sufficient: true, value: 0, label: "x" })).toBe("0");
    const empty = renderToStaticMarkup(
      createElement(MetricRing, {
        model: { sufficient: false, value: 0, label: "Missing evidence" },
      }),
    );
    expect(empty).toContain("Insufficient data");
    expect(empty).not.toContain("0%");
    expect(empty).not.toContain(">0<");
  });
});

describe("internal guide", () => {
  it("is staff gated and does not add a contract or outreach route", () => {
    const page = readFileSync("src/app/(app)/app/ui-guide/page.tsx", "utf8");
    expect(page).toContain('requireRole(["admin", "editor"]');
    expect(page).toContain("MANDATORY_STATES");
    expect(page).toContain("PROVENANCE_BADGES");
    expect(page).not.toContain("/app/contracts");
    expect(page).not.toContain("/app/outreach");
    expect(page).not.toMatch(/hunter|rebill|gmail\.send/i);
  });
});
