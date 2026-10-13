/**
 * D125 portfolio display. A failed read is not an empty suggestion list.
 * Compensation and contacts are not a portfolio field.
 */
import { describe, expect, it } from "vitest";

import { mapPublicShare } from "@/lib/profile/share-contract";
import {
  PORTFOLIO_COPY,
  mapOwnPortfolio,
  portfolioListOutcome,
} from "@/lib/profile/portfolio-contract";

const entry = {
  collaboration_id: "a0320000-0000-4000-8000-000000000001",
  hotel_name: "Public Reef",
  destination_name: "Alpha Bay",
  collaboration_type: "stay",
  status: "completed",
  start_date: "2026-01-02",
  end_date: "2026-08-01",
};

const publicEntry = {
  hotel_name: entry.hotel_name,
  destination_name: entry.destination_name,
  collaboration_type: entry.collaboration_type,
  status: entry.status,
  start_date: entry.start_date,
  end_date: entry.end_date,
};

describe("owner portfolio payload", () => {
  it("treats a missing profile as null and an empty bucket as empty", () => {
    expect(mapOwnPortfolio(null)).toEqual({ status: "missing" });
    const empty = mapOwnPortfolio({
      template: null,
      suggestions: [],
      published: [],
      dismissed: [],
      withheld: [],
    });
    expect(empty.status).toBe("ok");
    if (empty.status === "ok") expect(empty.portfolio.suggestions).toEqual([]);
    expect(portfolioListOutcome({ failed: true, suggestionCount: 0 })).toBe("error");
    expect(portfolioListOutcome({ failed: false, suggestionCount: 0 })).toBe("empty");
    expect(PORTFOLIO_COPY.error).not.toBe(PORTFOLIO_COPY.emptySuggestions);
  });

  it("rejects compensation, a contact, and a cancelled suggestion", () => {
    expect(
      mapOwnPortfolio({
        template: null,
        suggestions: [{ ...entry, compensation: { structure: "paid" } }],
        published: [],
        dismissed: [],
        withheld: [],
      }).status,
    ).toBe("error");
    expect(
      mapOwnPortfolio({
        template: null,
        suggestions: [{ ...entry, status: "cancelled" }],
        published: [],
        dismissed: [],
        withheld: [],
      }).status,
    ).toBe("error");
    expect(
      mapOwnPortfolio({
        template: "ranked",
        suggestions: [],
        published: [],
        dismissed: [],
        withheld: [],
      }).status,
    ).toBe("error");
  });
});

describe("share link portfolio", () => {
  it("renders a chosen layout and rejects compensation or a cancelled row", () => {
    const ok = mapPublicShare({
      result: "ok",
      profile: {
        portfolio: {
          template: "journey",
          entries: [publicEntry],
        },
      },
    });
    expect(ok.status).toBe("ok");
    if (ok.status === "ok") {
      expect(ok.view.portfolio?.template).toBe("journey");
      expect(ok.view.portfolio?.entries[0]?.destination).toBe("Alpha Bay");
      expect(ok.view.portfolio?.entries[0]?.when).toBe("2026-01-02 – 2026-08-01");
    }

    const unknownDestination = mapPublicShare({
      result: "ok",
      profile: {
        portfolio: {
          template: "highlights",
          entries: [{ ...publicEntry, destination_name: null }],
        },
      },
    });
    expect(unknownDestination.status).toBe("ok");
    if (unknownDestination.status === "ok") {
      expect(unknownDestination.view.portfolio?.entries[0]?.destination).toBe("Unknown");
    }

    expect(
      mapPublicShare({
        result: "ok",
        profile: {
          portfolio: {
            template: "journey",
            entries: [
              { ...publicEntry, compensation: { structure: "paid", cash_amount_minor: 864201 } },
            ],
          },
        },
      }).status,
    ).toBe("error");
    expect(
      mapPublicShare({
        result: "ok",
        profile: {
          portfolio: { template: "journey", entries: [{ ...publicEntry, status: "cancelled" }] },
        },
      }).status,
    ).toBe("error");
    expect(
      mapPublicShare({
        result: "ok",
        profile: { portfolio: { template: "journey", entries: [] } },
      }).status,
    ).toBe("error");
  });

  it("leaves a profile that has no portfolio key unchanged", () => {
    expect(mapPublicShare({ result: "ok", profile: { bio: "Hi" } })).toEqual({
      status: "ok",
      view: { bio: "Hi" },
    });
  });
});
