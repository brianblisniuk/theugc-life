/**
 * C02–C05 display and parser gates (D099).
 *
 * A missing network row is not zero. Insufficient is not a metric. A false
 * collaboration is not a signal. Evidence ids never survive the parser.
 */
import { describe, expect, it } from "vitest";

import {
  parseNetworkRow,
  parseOwnFacts,
  parsePilotKpis,
  parseProvenance,
} from "@/lib/network-intelligence/contract";
import {
  confidenceBand,
  factTypeLabel,
  gmailPromptCopy,
  networkPanelState,
} from "@/lib/network-intelligence/display";

describe("network confidence and panel state", () => {
  it("uses the D012 bands and does not treat a short sample as emerging", () => {
    expect(confidenceBand(0)).toBe("insufficient");
    expect(confidenceBand(4)).toBe("insufficient");
    expect(confidenceBand(5)).toBe("emerging");
    expect(confidenceBand(14)).toBe("emerging");
    expect(confidenceBand(15)).toBe("moderate");
    expect(confidenceBand(49)).toBe("moderate");
    expect(confidenceBand(50)).toBe("strong");
    expect(confidenceBand(-1)).toBeNull();
    expect(confidenceBand(1.5)).toBeNull();
  });

  it("keeps a missing row, an error, and an insufficient row apart", () => {
    expect(networkPanelState({ status: "none" })).toBe("building");
    expect(networkPanelState({ status: "error" })).toBe("error");
    expect(
      networkPanelState({
        status: "ok",
        row: {
          confidenceLevel: "insufficient",
          activityLevel: null,
          hasObservedCollaboration: null,
          recencyBand: null,
          freshnessBand: null,
        },
      }),
    ).toBe("insufficient");
    expect(
      networkPanelState({
        status: "ok",
        row: {
          confidenceLevel: "emerging",
          activityLevel: "emerging",
          hasObservedCollaboration: null,
          recencyBand: null,
          freshnessBand: null,
        },
      }),
    ).toBe("signal");
    expect(
      networkPanelState({
        status: "ok",
        row: {
          confidenceLevel: "emerging",
          activityLevel: null,
          hasObservedCollaboration: false as unknown as null,
          recencyBand: null,
          freshnessBand: null,
        },
      }),
    ).toBe("insufficient");
  });

  it("labels a manual pitch and a confirmed Gmail reading as different families", () => {
    expect(factTypeLabel("pitch_sent")).toBe("Pitch sent");
    expect(factTypeLabel("gmail_thread_commercial_state")).toBe("Thread reading");
    expect(gmailPromptCopy("confirmed_not_admitted")).toContain("did not enter the network");
    expect(gmailPromptCopy("dismissed")).toContain("does not enter the network");
    expect(gmailPromptCopy("pending")).toBeNull();
  });
});

describe("network parsers refuse identity", () => {
  it("drops an own-facts payload that carries an evidence id", () => {
    expect(
      parseOwnFacts({
        result: "ok",
        manual: [
          {
            fact_type: "pitch_sent",
            provenance_class: "creator_confirmed",
            source_family: "manual",
            event_at: "2026-10-13T00:00:00.000Z",
            evidence_id: "11111111-1111-4111-8111-111111111111",
          },
        ],
        gmail: [],
      }),
    ).toEqual({ status: "error" });
  });

  it("rejects a false collaboration and a creator id on the public row", () => {
    expect(
      parseNetworkRow({
        confidence_level: "emerging",
        activity_level: "emerging",
        has_observed_collaboration: false,
        recency_band: null,
        freshness_band: null,
      }),
    ).toBeNull();
    expect(
      parseNetworkRow({
        confidence_level: "insufficient",
        activity_level: null,
        has_observed_collaboration: null,
        recency_band: null,
        freshness_band: null,
        owner_user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    ).toBeNull();
  });

  it("treats a zero-decision rate as null and refuses milliseconds", () => {
    const empty = parsePilotKpis({
      result: "ok",
      confirmed_facts_per_creator: [],
      gmail_confirmed: 0,
      gmail_dismissed: 0,
      gmail_confirmed_pct: null,
      gmail_dismissed_pct: null,
      hotels_emerging_or_above: 0,
      hotel_response_time: [],
      retention: { creators_who_viewed: 0, creators_who_returned: 0, return_rate: null },
    });
    expect(empty.status).toBe("ok");
    if (empty.status === "ok") {
      expect(empty.kpis.gmailConfirmedPct).toBeNull();
      expect(empty.kpis.returnRate).toBeNull();
    }
    expect(
      parsePilotKpis({
        result: "ok",
        confirmed_facts_per_creator: [],
        gmail_confirmed: 1,
        gmail_dismissed: 1,
        gmail_confirmed_pct: 50,
        gmail_dismissed_pct: 50,
        hotels_emerging_or_above: 0,
        hotel_response_time: [{ hotel_id: "h", response_time_band: "under_24h", mean_ms: 10 }],
        retention: { creators_who_viewed: 0, creators_who_returned: 0, return_rate: null },
      }),
    ).toEqual({ status: "error" });
  });

  it("hides provenance from a not_found answer and keeps it for an admin payload", () => {
    expect(parseProvenance({ result: "not_found" })).toEqual({ status: "hidden" });
    const shown = parseProvenance({
      result: "ok",
      fact_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      owner_user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      fact_type: "pitch_sent",
      provenance_class: "creator_confirmed",
      source_family: "manual",
      evidence_kind: "outreach_event",
      evidence_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      canonical_hotel_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });
    expect(shown.status).toBe("ok");
  });
});
